const mongoose = require('mongoose');
const User = require('../models/User');
const { success } = require('../utils/response');

const ALLOWED_FIELDS = new Set(['nombre', 'correo', 'telefono', 'rol', 'status']);
const ALLOWED_ROLES = new Set(['developer', 'admin', 'user', 'consultor']);
const ALLOWED_STATUSES = new Set(['activo', 'inactivo', 'suspendido']);

const validateUserInput = (body, partial) => {
  const errors = {};
  const value = {};

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { body: 'A JSON object is required' }, value };
  }
  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) errors[field] = 'Unknown field';
  }

  if (!partial || body.nombre !== undefined) {
    if (typeof body.nombre !== 'string' || !body.nombre.trim()) {
      errors.nombre = 'A name is required';
    } else if (body.nombre.trim().length > 120) {
      errors.nombre = 'Must not exceed 120 characters';
    } else {
      value.nombre = body.nombre.trim();
    }
  }

  if (!partial || body.correo !== undefined) {
    if (typeof body.correo !== 'string' || !body.correo.trim()) {
      errors.correo = 'An email is required';
    } else {
      const correo = body.correo.trim().toLowerCase();
      if (correo.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
        errors.correo = 'Must be a valid email address';
      } else {
        value.correo = correo;
      }
    }
  }

  if (body.telefono !== undefined) {
    if (body.telefono === null || (typeof body.telefono === 'string' && !body.telefono.trim())) {
      if (partial) value.telefono = undefined;
    } else if (typeof body.telefono !== 'string') {
      errors.telefono = 'Must be a valid phone number';
    } else {
      const telefono = body.telefono.trim();
      const digits = telefono.replace(/\D/g, '');
      if (!/^\+?[\d\s().-]+$/.test(telefono) || digits.length < 7 || digits.length > 15) {
        errors.telefono = 'Must be a valid phone number';
      } else {
        value.telefono = telefono;
      }
    }
  }

  if (body.rol !== undefined) {
    if (!ALLOWED_ROLES.has(body.rol)) errors.rol = `Must be one of: ${[...ALLOWED_ROLES].join(', ')}`;
    else value.rol = body.rol;
  }
  if (body.status !== undefined) {
    if (!ALLOWED_STATUSES.has(body.status)) errors.status = `Must be one of: ${[...ALLOWED_STATUSES].join(', ')}`;
    else value.status = body.status;
  }

  return { errors, value };
};

const publicUser = (user) => ({
  _id: user._id,
  nombre: user.nombre,
  correo: user.correo,
  telefono: user.telefono,
  rol: user.rol,
  status: user.status,
  autenticacion: {
    proveedor: user.autenticacion?.proveedor,
    ultimoAcceso: user.autenticacion?.ultimoAcceso,
  },
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const sendValidationFailure = (res, errors) =>
  res.status(400).json({ success: false, message: 'Validation failed', errors });

const validateId = (id, res) => {
  if (mongoose.isValidObjectId(id)) return true;
  res.status(400).json({ success: false, message: 'Invalid user ID' });
  return false;
};

const sendDatabaseError = (err, res, next) => {
  if (err.name === 'ValidationError') {
    const errors = Object.fromEntries(
      Object.entries(err.errors).map(([field, detail]) => [field, detail.message])
    );
    return sendValidationFailure(res, errors);
  }
  if (err.code === 11000) {
    const duplicateField = Object.keys(err.keyPattern || err.keyValue || {})[0];
    const message = duplicateField === 'telefono'
      ? 'A user with this phone number already exists'
      : 'A user with this email already exists';
    return res.status(409).json({ success: false, message });
  }
  return next(err);
};

const isLastActiveDeveloper = async (user, nextRole, nextStatus) => {
  if (user.rol !== 'developer' || user.status !== 'activo') return false;
  if (nextRole === 'developer' && nextStatus === 'activo') return false;
  return (await User.countDocuments({ rol: 'developer', status: 'activo' })) <= 1;
};

const getUsers = async (req, res, next) => {
  try {
    const users = await User.find()
      .select('nombre correo telefono rol status autenticacion.proveedor autenticacion.ultimoAcceso createdAt updatedAt')
      .sort({ nombre: 1 });
    return success(res, users, 'Users fetched');
  } catch (err) {
    return next(err);
  }
};

const createUser = async (req, res, next) => {
  const { errors, value } = validateUserInput(req.body, false);
  if (Object.keys(errors).length) return sendValidationFailure(res, errors);

  try {
    const user = await User.create({
      ...value,
      rol: value.rol || 'user',
      status: value.status || 'activo',
    });
    return success(res, publicUser(user), 'User created', 201);
  } catch (err) {
    return sendDatabaseError(err, res, next);
  }
};

const updateUser = async (req, res, next) => {
  if (!validateId(req.params.id, res)) return undefined;
  const { errors, value } = validateUserInput(req.body, true);
  if (!Object.keys(errors).length && !Object.keys(value).length) {
    errors.body = 'At least one editable field is required';
  }
  if (Object.keys(errors).length) return sendValidationFailure(res, errors);

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isSelf = String(user._id) === String(req.user._id);
    if (isSelf && ((value.rol && value.rol !== user.rol) || (value.status && value.status !== user.status))) {
      return res.status(409).json({ success: false, message: 'You cannot change your own role or status' });
    }

    const nextRole = value.rol || user.rol;
    const nextStatus = value.status || user.status;
    if (await isLastActiveDeveloper(user, nextRole, nextStatus)) {
      return res.status(409).json({ success: false, message: 'At least one active developer must remain' });
    }

    Object.assign(user, value);
    await user.save();
    return success(res, publicUser(user), 'User updated');
  } catch (err) {
    return sendDatabaseError(err, res, next);
  }
};

const deactivateUser = async (req, res, next) => {
  if (!validateId(req.params.id, res)) return undefined;

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (String(user._id) === String(req.user._id)) {
      return res.status(409).json({ success: false, message: 'You cannot deactivate your own account' });
    }
    if (await isLastActiveDeveloper(user, user.rol, 'inactivo')) {
      return res.status(409).json({ success: false, message: 'At least one active developer must remain' });
    }

    user.status = 'inactivo';
    await user.save();
    return success(res, publicUser(user), 'User deactivated');
  } catch (err) {
    return sendDatabaseError(err, res, next);
  }
};

module.exports = { getUsers, createUser, updateUser, deactivateUser };
