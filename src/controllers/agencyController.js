const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const SentEmail = require('../models/SentEmail');
const { success } = require('../utils/response');
const { updateDrivePattern } = require('../utils/drivePatternUtils');
const { FILE_TYPES, selectRefreshFiles } = require('../utils/agencyFileRefreshUtils');

const ALLOWED_FIELDS = new Set([
  'nombre',
  'correo',
  'entidadFederativa',
  'status',
  'archivos',
]);
const ALLOWED_STATUSES = new Set(['activa', 'inactiva', 'suspendida']);
const FILE_FIELDS = new Set(['archivo1', 'archivo2', 'archivo3', 'archivo4']);
const FILE_CODES = { archivo1: 'ANX', archivo2: 'FOR', archivo3: 'REP', archivo4: 'REV' };
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
        if (field === 'carpetaPrincipal' || field === 'carpetaBase') {
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
          if (!['nombre', 'ruta', 'driveId', 'pseudoPath', 'path'].includes(key)) {
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

        let driveId;
        if (file.driveId !== undefined) {
          if (typeof file.driveId !== 'string' || file.driveId.trim().length > 2048) {
            errors[`archivos.${field}.driveId`] = 'Must be a string of at most 2048 characters';
          } else if (file.driveId.trim()) {
            driveId = file.driveId.trim();
          }
        }

        let pseudoPath;
        if (file.pseudoPath !== undefined) {
          if (!Array.isArray(file.pseudoPath) || file.pseudoPath.length > 100 || file.pseudoPath.some((part) => (
            typeof part !== 'string' || !part.trim() || part.trim().length > 255
          ))) {
            errors[`archivos.${field}.pseudoPath`] = 'Must be an array of up to 100 non-empty strings of at most 255 characters';
          } else {
            pseudoPath = file.pseudoPath.map((part) => part.trim());
          }
        }

        let path;
        if (file.path !== undefined) {
          if (typeof file.path !== 'string' || !file.path.trim() || file.path.trim().length > 4096) {
            errors[`archivos.${field}.path`] = 'Must be a non-empty string of at most 4096 characters';
          } else {
            path = file.path.trim();
          }
        }

        if (nombre && ruta && nombre.length <= 255 && ruta.length <= 2048) {
          archivos[field] = {
            nombre,
            ruta,
            ...(driveId !== undefined ? { driveId } : {}),
            ...(pseudoPath !== undefined ? { pseudoPath } : {}),
            ...(path !== undefined ? { path } : {}),
          };
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

    req.auditRecovery = { entity: 'Agency', snapshot: agency.toObject({ depopulate: true }) };
    await agency.deleteOne();
    return success(res, { id: agency._id }, 'Agency deleted');
  } catch (err) {
    return next(err);
  }
};

const learnAgencyPattern = async (req, res, next) => {
  if (!validateId(req.params.id, res)) return;

  const { year, month, files, rootFolderName } = req.body;

  if (!Number.isInteger(year) || year < 2020 || year > 2040)
    return validationFailure(res, { year: 'Must be an integer between 2020 and 2040' });
  if (!Number.isInteger(month) || month < 1 || month > 12)
    return validationFailure(res, { month: 'Must be an integer between 1 and 12' });
  if (!Array.isArray(files) || files.length === 0)
    return validationFailure(res, { files: 'Must be a non-empty array' });
  if (typeof rootFolderName !== 'string' || !rootFolderName.trim())
    return validationFailure(res, { rootFolderName: 'Required' });

  const normalizedRoot = rootFolderName.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [index, file] of files.entries()) {
    const field = `files.${index}`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      return validationFailure(res, { [field]: 'Must be an object' });
    }
    if (!FILE_FIELDS.has(file.key) || file.code !== FILE_CODES[file.key]) {
      return validationFailure(res, { [`${field}.key`]: 'Unknown file type or code mismatch' });
    }
    if (typeof file.fileName !== 'string' || !file.fileName.trim()) {
      return validationFailure(res, { [`${field}.fileName`]: 'Required' });
    }
    if (typeof file.fileId !== 'string' || !file.fileId.trim()) {
      return validationFailure(res, { [`${field}.fileId`]: 'Drive file ID is required' });
    }
    if (!Array.isArray(file.folderPath) || file.folderPath.some((segment) => typeof segment !== 'string' || !segment.trim())) {
      return validationFailure(res, { [`${field}.folderPath`]: 'Must be an array of non-empty path segments' });
    }
    const hasRoot = file.folderPath.some((segment) => (
      segment.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === normalizedRoot
    ));
    if (!hasRoot) {
      return validationFailure(res, { [`${field}.folderPath`]: 'Must include rootFolderName' });
    }
  }

  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });

    const newPattern = updateDrivePattern(
      agency.drivePattern?.toObject?.() || agency.drivePattern || {},
      rootFolderName.trim(),
      files,
      year,
      month
    );

    agency.set('drivePattern', newPattern);
    agency.markModified('drivePattern');
    await agency.save();

    return success(res, { drivePattern: agency.drivePattern }, 'Pattern learned');
  } catch (err) {
    return next(err);
  }
};

const refreshAgencyFiles = async (req, res, next) => {
  if (!validateId(req.params.id, res)) return;

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return validationFailure(res, { body: 'A JSON object is required' });
  }

  const { year, month, descendants } = body;

  if (!Number.isInteger(year) || year < 2020 || year > 2040)
    return validationFailure(res, { year: 'Must be an integer between 2020 and 2040' });
  if (!Number.isInteger(month) || month < 1 || month > 12)
    return validationFailure(res, { month: 'Must be an integer between 1 and 12' });
  if (!Array.isArray(descendants))
    return validationFailure(res, { descendants: 'Must be an array' });
  if (descendants.length > 10000)
    return validationFailure(res, { descendants: 'Must contain no more than 10000 entries' });

  const inputErrors = {};
  descendants.forEach((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      inputErrors[`descendants.${index}`] = 'Must be an object';
      return;
    }
    if (typeof file.id !== 'string' || !file.id.trim() || file.id.length > 2048) {
      inputErrors[`descendants.${index}.id`] = 'A Drive ID of at most 2048 characters is required';
    }
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255) {
      inputErrors[`descendants.${index}.name`] = 'A file name of at most 255 characters is required';
    }
    if (file.mimeType !== undefined && (typeof file.mimeType !== 'string' || file.mimeType.length > 255)) {
      inputErrors[`descendants.${index}.mimeType`] = 'Must be a string of at most 255 characters';
    }
    for (const field of ['parents', 'folderPath']) {
      if (file[field] !== undefined && (
        !Array.isArray(file[field])
        || file[field].length > 100
        || file[field].some((part) => typeof part !== 'string' || part.length > 255)
      )) {
        inputErrors[`descendants.${index}.${field}`] = 'Must be an array of at most 100 strings of at most 255 characters';
      }
    }
    if (file.path !== undefined && (typeof file.path !== 'string' || file.path.length > 4096)) {
      inputErrors[`descendants.${index}.path`] = 'Must be a string of at most 4096 characters';
    }
  });
  if (Object.keys(inputErrors).length) return validationFailure(res, inputErrors);

  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });

    const selected = selectRefreshFiles(descendants, year, month);
    const results = {};
    const newArchivos = { ...(agency.archivos?.toObject?.() || agency.archivos || {}) };

    for (const { key } of FILE_TYPES) {
      const match = selected[key];
      if (!match) {
        results[key] = { status: 'missing' };
        continue;
      }

      const file = match.file;
      const folderPath = Array.isArray(file.folderPath)
        ? file.folderPath
        : splitDrivePath(file.path).slice(0, -1);
      const persistedFile = {
        nombre: file.name.trim(),
        ruta: file.parents?.[0] || file.id,
        driveId: file.id,
        pseudoPath: folderPath,
        path: typeof file.path === 'string' && file.path.trim()
          ? file.path.trim()
          : [...folderPath, file.name.trim()].join(' / '),
        periodYear: match.period.year,
        periodMonth: match.period.month,
      };

      newArchivos[key] = persistedFile;
      results[key] = {
        status: 'found',
        file: persistedFile,
        periodYear: match.period.year,
        periodMonth: match.period.month,
      };
    }

    agency.set('archivos', newArchivos);
    await agency.save();

    return success(res, {
      archivos: agency.archivos,
      results,
      summary: {
        found: FILE_TYPES.filter(({ key }) => results[key].status === 'found').length,
        missing: FILE_TYPES.filter(({ key }) => results[key].status === 'missing').length,
        year,
        month,
      },
    }, 'Files refreshed');
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
  learnAgencyPattern,
  refreshAgencyFiles,
};

const splitDrivePath = (path = '') => String(path).split(/[\\/]/).map((part) => part.trim()).filter(Boolean);