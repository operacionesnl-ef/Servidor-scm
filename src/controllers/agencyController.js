const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const SentEmail = require('../models/SentEmail');
const { success } = require('../utils/response');

const ALLOWED_FIELDS = new Set([
  'nombre',
  'correo',
  'entidadFederativa',
  'status',
  'archivos',
]);
const ALLOWED_STATUSES = new Set(['activa', 'inactiva', 'suspendida']);
const FILE_FIELDS = new Set(['archivo1', 'archivo2', 'archivo3', 'archivo4']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validationFailure = (res, errors) =>
  res.status(400).json({ success: false, message: 'Validation failed', errors });

const validateAgencyInput = (body, partial) => {
  const errors = {};
  const value = {};

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { body: 'A JSON object is required' } };
  }

  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) errors[field] = 'Unknown field';
  }

  for (const [field, maximum] of [['nombre', 120], ['entidadFederativa', 100]]) {
    if (body[field] === undefined && partial) continue;
    if (typeof body[field] !== 'string' || !body[field].trim()) {
      errors[field] = 'This field is required';
    } else if (body[field].trim().length > maximum) {
      errors[field] = `Must not exceed ${maximum} characters`;
    } else {
      value[field] = body[field].trim();
    }
  }

  if (body.correo === undefined && partial) {
    // Leave omitted email unchanged on partial updates.
  } else if (typeof body.correo !== 'string' || !body.correo.trim()) {
    errors.correo = 'This field is required';
  } else {
    const correo = body.correo.trim().toLowerCase();
    if (correo.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      errors.correo = 'Must be a valid email address';
    } else {
      value.correo = correo;
    }
  }

  if (body.status !== undefined) {
    if (!ALLOWED_STATUSES.has(body.status)) {
      errors.status = `Must be one of: ${[...ALLOWED_STATUSES].join(', ')}`;
    } else {
      value.status = body.status;
    }
  }

  if (body.archivos !== undefined) {
    if (body.archivos === null) {
      value.archivos = null;
    } else if (!body.archivos || typeof body.archivos !== 'object' || Array.isArray(body.archivos)) {
      errors.archivos = 'Must be an object';
    } else {
      const archivos = {};
      for (const [field, file] of Object.entries(body.archivos)) {
        if (field === 'carpetaPrincipal') {
          if (typeof file !== 'string' || !file.trim() || file.trim().length > 2048) {
            errors[`archivos.${field}`] = 'Must be a non-empty string of at most 2048 characters';
          } else {
            archivos[field] = file.trim();
          }
          continue;
        }

        if (!FILE_FIELDS.has(field)) {
          errors[`archivos.${field}`] = 'Unknown field';
          continue;
        }
        if (file === null) {
          archivos[field] = null;
          continue;
        }
        if (!file || typeof file !== 'object' || Array.isArray(file)) {
          errors[`archivos.${field}`] = 'Must be an object';
          continue;
        }

        for (const key of Object.keys(file)) {
          if (key !== 'nombre' && key !== 'ruta') {
            errors[`archivos.${field}.${key}`] = 'Unknown field';
          }
        }

        const nombre = typeof file.nombre === 'string' ? file.nombre.trim() : '';
        const ruta = typeof file.ruta === 'string' ? file.ruta.trim() : '';
        if (!nombre || nombre.length > 255) {
          errors[`archivos.${field}.nombre`] = 'A name of at most 255 characters is required';
        }
        if (!ruta || ruta.length > 2048) {
          errors[`archivos.${field}.ruta`] = 'A path of at most 2048 characters is required';
        }
        if (nombre && ruta && nombre.length <= 255 && ruta.length <= 2048) {
          archivos[field] = { nombre, ruta };
        }
      }
      value.archivos = archivos;
    }
  }

  return { errors, value };
};

const sendDatabaseError = (err, res, next) => {
  if (err.name === 'ValidationError') {
    const errors = Object.fromEntries(
      Object.entries(err.errors).map(([field, detail]) => [field, detail.message])
    );
    return validationFailure(res, errors);
  }
  if (err.code === 11000) {
    return res.status(409).json({ success: false, message: 'An agency with this email already exists' });
  }
  return next(err);
};

const validateId = (id, res) => {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ success: false, message: 'Invalid agency ID' });
    return false;
  }
  return true;
};

const getMissingAgencyFields = (agency) => {
  const missingFields = [];
  if (typeof agency.nombre !== 'string' || !agency.nombre.trim()) missingFields.push('nombre');
  if (
    typeof agency.correo !== 'string' ||
    !EMAIL_PATTERN.test(agency.correo.trim())
  ) {
    missingFields.push('correo');
  }
  if (typeof agency.entidadFederativa !== 'string' || !agency.entidadFederativa.trim()) {
    missingFields.push('entidadFederativa');
  }

  const files = agency.archivos || {};
  if (typeof files.carpetaPrincipal !== 'string' || !files.carpetaPrincipal.trim()) {
    missingFields.push('archivos.carpetaPrincipal');
  }
  for (const field of FILE_FIELDS) {
    const file = files[field] || {};
    if (typeof file.nombre !== 'string' || !file.nombre.trim()) {
      missingFields.push(`archivos.${field}.nombre`);
    }
    if (typeof file.ruta !== 'string' || !file.ruta.trim()) {
      missingFields.push(`archivos.${field}.ruta`);
    }
  }
  return missingFields;
};

const getAgencyEmails = async (req, res, next) => {
  const options = {};
  for (const field of ['includeIncomplete', 'includeInactive']) {
    const value = req.query[field];
    if (value !== undefined && value !== 'true' && value !== 'false') {
      return validationFailure(res, { [field]: 'Must be true or false' });
    }
    options[field] = value === 'true';
  }

  try {
    const agencies = await Agency.find()
      .select('nombre correo entidadFederativa status archivos')
      .sort({ createdAt: -1 });
    const emails = [];
    const incomplete = [];
    const inactive = [];

    for (const agency of agencies) {
      if (agency.status !== 'activa') {
        inactive.push({
          id: agency._id,
          nombre: agency.nombre,
          correo: agency.correo,
          status: agency.status,
        });
        continue;
      }

      const missingFields = getMissingAgencyFields(agency);
      if (missingFields.length) {
        incomplete.push({
          id: agency._id,
          nombre: agency.nombre,
          correo: agency.correo,
          status: agency.status,
          missingFields,
        });
      } else {
        emails.push(agency.correo.trim().toLowerCase());
      }
    }

    return success(res, {
      emails,
      incomplete: options.includeIncomplete ? incomplete : [],
      inactive: options.includeInactive ? inactive : [],
      summary: {
        activeComplete: emails.length,
        activeIncomplete: incomplete.length,
        inactive: inactive.length,
      },
    }, 'Agency emails fetched');
  } catch (err) {
    return next(err);
  }
};

const getAgencies = async (req, res, next) => {
  try {
    if (req.query.status && !ALLOWED_STATUSES.has(req.query.status)) {
      return validationFailure(res, { status: `Must be one of: ${[...ALLOWED_STATUSES].join(', ')}` });
    }
    const filter = req.query.status ? { status: req.query.status } : {};
    const agencies = await Agency.find(filter).sort({ createdAt: -1 });
    return success(res, agencies, 'Agencies fetched');
  } catch (err) {
    return next(err);
  }
};

const getAgencyById = async (req, res, next) => {
  if (!validateId(req.params.id, res)) return;
  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    return success(res, agency, 'Agency fetched');
  } catch (err) {
    return next(err);
  }
};

const createAgency = async (req, res, next) => {
  const { errors, value } = validateAgencyInput(req.body, false);
  if (Object.keys(errors).length) return validationFailure(res, errors);

  try {
    const duplicate = await Agency.exists({ correo: value.correo });
    if (duplicate) {
      return res.status(409).json({ success: false, message: 'An agency with this email already exists' });
    }
    const agency = await Agency.create(value);
    return success(res, agency, 'Agency created', 201);
  } catch (err) {
    return sendDatabaseError(err, res, next);
  }
};

const updateAgency = async (req, res, next) => {
  if (!validateId(req.params.id, res)) return;
  const partial = req.method === 'PATCH';
  const { errors, value } = validateAgencyInput(req.body, partial);
  if (Object.keys(errors).length) return validationFailure(res, errors);

  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });

    if (value.correo) {
      const duplicate = await Agency.exists({ correo: value.correo, _id: { $ne: agency._id } });
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'An agency with this email already exists' });
      }
    }

    for (const field of ['nombre', 'correo', 'entidadFederativa', 'status']) {
      if (value[field] !== undefined) agency.set(field, value[field]);
    }

    if (Object.hasOwn(value, 'archivos')) {
      if (!partial || value.archivos === null) {
        agency.set('archivos', value.archivos);
      } else {
        const currentFiles = agency.archivos?.toObject?.() || agency.archivos || {};
        agency.set('archivos', { ...currentFiles, ...value.archivos });
      }
    }

    await agency.save();
    return success(res, agency, 'Agency updated');
  } catch (err) {
    return sendDatabaseError(err, res, next);
  }
};

const deleteAgency = async (req, res, next) => {
  if (!validateId(req.params.id, res)) return;
  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });

    const hasSentEmails = await SentEmail.exists({ agencia: agency._id });
    if (hasSentEmails) {
      return res.status(409).json({
        success: false,
        message: 'Agency cannot be deleted while sent email records reference it',
      });
    }

    await agency.deleteOne();
    return success(res, { id: agency._id }, 'Agency deleted');
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getAgencyEmails,
  getAgencies,
  getAgencyById,
  createAgency,
  updateAgency,
  deleteAgency,
};