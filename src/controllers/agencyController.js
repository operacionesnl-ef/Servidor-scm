const mongoose = require('mongoose');
const { google } = require('googleapis');
const Agency = require('../models/Agency');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const ForReport = require('../formatosGeneradores/for/models/ForReport');
const AgencyNote = require('../models/AgencyNote');
const AgencyPersonalization = require('../models/AgencyPersonalization');
const AgencyRefreshJob = require('../models/AgencyRefreshJob');
const CalendarEvent = require('../models/CalendarEvent');
const GlobalSetting = require('../models/GlobalSetting');
const Notification = require('../models/Notification');
const SentEmail = require('../models/SentEmail');
const User = require('../models/User');
const { success } = require('../utils/response');
const { updateDrivePattern } = require('../utils/drivePatternUtils');
const { FILE_TYPES } = require('../utils/agencyFileRefreshUtils');
const { encryptGoogleToken } = require('../utils/mailJobCrypto');
const { kickAgencyRefreshJobWorker } = require('../services/agencyRefreshJobWorker');
const { refreshAgencyFromDrive } = require('../services/agencyDriveRefresh');
const { normalizeEmailList } = require('../utils/emailList');
const { getMexicoPeriod } = require('../utils/notificationUtils');
const { logEvent } = require('../utils/consoleLogger');
const { recordAgencyHistory } = require('../services/agencyHistory');
const { notifyAgencyConsultants, notifyConsultant } = require('../services/consultantNotifications');
const { getAgencyConsultantFilter, getAgencyConsultants } = require('../utils/agencyConsultants');
const { ensureMonthlyRecalendarization } = require('../services/monthlyRecalendarization');

const AGENCY_SEARCH_PERIOD_SETTING = 'agency-search-period';

const serializeAgencySearchPeriod = (setting) => ({
  year: setting.year,
  month: setting.month,
});

const getAgencySearchPeriod = async (req, res, next) => {
  try {
    const setting = await GlobalSetting.findById(AGENCY_SEARCH_PERIOD_SETTING).lean();
    return res.json(serializeAgencySearchPeriod(setting || getMexicoPeriod()));
  } catch (error) {
    return next(error);
  }
};

const updateAgencySearchPeriod = async (req, res, next) => {
  const { year, month } = req.body || {};
  if (!Number.isInteger(year) || year < 2020 || year > 2040) {
    return validationFailure(res, { year: 'Must be an integer between 2020 and 2040' });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return validationFailure(res, { month: 'Must be an integer between 1 and 12' });
  }

  try {
    const previous = await GlobalSetting.findById(AGENCY_SEARCH_PERIOD_SETTING).lean();
    const setting = await GlobalSetting.findOneAndUpdate(
      { _id: AGENCY_SEARCH_PERIOD_SETTING },
      { $set: { year, month, updatedBy: req.user._id } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();

    if (previous?.year !== year || previous?.month !== month) {
      const label = `${String(month).padStart(2, '0')}/${year}`;
      await Notification.create({
        title: 'Período de archivos actualizado',
        message: `El período compartido para buscar y verificar archivos se cambió a ${label}.`,
        severity: 'low',
        audience: 'all',
        createdBy: req.user._id,
      });
    }

    return res.json(serializeAgencySearchPeriod(setting));
  } catch (error) {
    return next(error);
  }
};

const ALLOWED_FIELDS = new Set([
  'nombre',
  'razonSocial',
  'RFC',
  'direccion',
  'ciudad',
  'longitud',
  'latitud',
  'correo',
  'gerente',
  'telefonoGerente',
  'seguimiento',
  'cc',
  'cco',
  'entidadFederativa',
  'marca',
  'fileNameCode',
  'status',
  'archivos',
  'consultantId',
  'auxiliaryConsultantId',
  'reviewPeriods',
]);
const ALLOWED_STATUSES = new Set(['activa', 'inactiva', 'suspendida']);
const FILE_FIELDS = new Set(['archivo1', 'archivo2', 'archivo3', 'archivo4']);
const FILE_CODES = { archivo1: 'ANX', archivo2: 'FOR', archivo3: 'REP', archivo4: 'REV' };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AGENCY_HISTORY_FIELD_LABELS = {
  nombre: 'Nombre',
  razonSocial: 'Razon Social',
  RFC: 'RFC',
  direccion: 'Dirección',
  ciudad: 'Ciudad',
  longitud: 'Longitud',
  latitud: 'Latitud',
  correo: 'Correo',
  gerente: 'Gerente',
  telefonoGerente: 'Teléfono del gerente',
  seguimiento: 'Seguimiento',
  cc: 'CC',
  cco: 'CCO',
  entidadFederativa: 'Entidad federativa',
  marca: 'Marca para carpeta de recorridos',
  status: 'Estado',
  consultantId: 'Consultor responsable',
  auxiliaryConsultantId: 'Consultor auxiliar',
  fileNameCode: 'Código de nombre de archivos',
  archivos: 'Archivos asociados',
};

function historyValue(value) {
  if (value && typeof value.toObject === 'function') value = value.toObject();
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function getAgencyField(agency, field) {
  return typeof agency.get === 'function' ? agency.get(field) : agency[field];
}

async function validateDriveToken(token) {
  const oauthClient = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID);
  oauthClient.setCredentials({ access_token: token });
  let tokenInfo;
  try {
    tokenInfo = await oauthClient.getTokenInfo(token);
  } catch (error) {
    if ([400, 401].includes(Number(error.code || error.response?.status))) {
      const invalidToken = new Error('La autorización de Google Drive expiró. Autoriza Drive e inténtalo de nuevo.');
      invalidToken.status = 401;
      throw invalidToken;
    }
    throw error;
  }
  if (!(tokenInfo.scopes || []).includes(REQUIRED_DRIVE_SCOPE)) {
    const error = new Error('Falta el permiso de lectura de Google Drive.');
    error.status = 403;
    throw error;
  }
  return oauthClient;
}

function serializeAgencyRefreshJob(job) {
  return {
    id: String(job._id),
    kind: job.jobType || 'refresh',
    status: job.status,
    year: job.year,
    month: job.month,
    total: job.total,
    completed: job.completed,
    currentName: job.currentName,
    scannedFiles: job.scannedFiles,
    failed: job.results
      .filter((result) => ['issues', 'failed'].includes(result.status))
      .map((result) => ({
        agency: {
          _id: result.agencyId,
          nombre: result.agencyName,
          correo: result.correo,
          entidadFederativa: result.entidadFederativa,
          status: result.agencyStatus,
          archivos: {
            ...(result.files || {}),
            ...(result.carpetaPrincipal ? { carpetaPrincipal: result.carpetaPrincipal } : {}),
          },
        },
        missingKeys: result.missingKeys,
        files: result.files || {},
        selectedFiles: {},
        period: result.period || '',
        error: result.error,
        missingRoot: result.missingRoot,
        checks: result.checks || [],
      })),
    skipped: job.results.filter((result) => result.status === 'skipped').length,
    results: job.results,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

const validationFailure = (res, errors) =>
  res.status(400).json({ success: false, message: 'Validation failed', errors });

function removeNullAgencyFileSlots(archivos) {
  if (!archivos || typeof archivos !== 'object' || Array.isArray(archivos)) return archivos;
  const result = { ...archivos };
  FILE_FIELDS.forEach((field) => {
    if (result[field] === null || result[field] === undefined) delete result[field];
  });
  return result;
}

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

  if (body.correo !== undefined && (typeof body.correo !== 'string' || !body.correo.trim())) {
    errors.correo = 'Must be a non-empty valid email address when provided';
  } else if (body.correo !== undefined) {
    const correo = body.correo.trim().toLowerCase();
    if (correo.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      errors.correo = 'Must be a valid email address';
    } else {
      value.correo = correo;
    }
  }

  for (const [field, maximum] of [['gerente', 120], ['telefonoGerente', 40], ['seguimiento', 4000]]) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string') {
      errors[field] = 'Must be a string';
    } else if (body[field].trim().length > maximum) {
      errors[field] = `Must not exceed ${maximum} characters`;
    } else {
      value[field] = body[field].trim();
    }
  }

  for (const field of ['razonSocial', 'RFC', 'direccion', 'ciudad']) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string') {
      errors[field] = 'Must be a string';
    } else if ((field === 'ciudad' && body[field].trim().length > 200)
      || (field === 'RFC' && body[field].trim().length > 13)) {
      errors[field] = `Must not exceed ${field === 'RFC' ? 13 : 200} characters`;
    } else {
      value[field] = field === 'RFC' ? body[field].trim().toLocaleUpperCase('es-MX') : body[field].trim();
    }

  }

  if (body.fileNameCode !== undefined) {
    if (typeof body.fileNameCode !== 'string'
      || body.fileNameCode.trim().length > 60
      || (body.fileNameCode.trim() && !/^[A-Za-z0-9_-]+$/.test(body.fileNameCode.trim()))) {
      errors.fileNameCode = 'Must contain at most 60 letters, numbers, underscores, or hyphens';
    } else {
      value.fileNameCode = body.fileNameCode.trim().toUpperCase();
    }
  }

  if (body.marca !== undefined) {
    const marca = typeof body.marca === 'string' ? body.marca.trim().replace(/\s+/g, ' ') : null;
    if (marca === null
      || marca.length > 80
      || /[<>:"/\\|?*\u0000-\u001f]/.test(marca)) {
      errors.marca = 'Must be at most 80 characters and cannot contain path or control characters';
    } else {
      value.marca = marca.toLocaleUpperCase('es-MX');
    }
  }

  for (const [field, minimum, maximum] of [
    ['longitud', -180, 180],
    ['latitud', -90, 90],
  ]) {
    if (body[field] === undefined) continue;
    if (body[field] === null) {
      value[field] = null;
    } else if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) {
      errors[field] = 'Must be a number or null';
    } else if (body[field] < minimum || body[field] > maximum) {
      errors[field] = `Must be between ${minimum} and ${maximum}`;
    } else {
      value[field] = body[field];
    }
  }

  if (body.consultantId !== undefined) {
    if (body.consultantId === null || body.consultantId === '') value.consultantId = null;
    else if (!mongoose.isValidObjectId(body.consultantId)) {
      errors.consultantId = 'Must be a valid consultant ID or null';
    } else {
      value.consultantId = body.consultantId;
    }
    if (body.auxiliaryConsultantId !== undefined) {
      if (body.auxiliaryConsultantId === null || body.auxiliaryConsultantId === '') {
        value.auxiliaryConsultantId = null;
      } else if (!mongoose.isValidObjectId(body.auxiliaryConsultantId)) {
        errors.auxiliaryConsultantId = 'Must be a valid auxiliary consultant ID or null';
      } else {
        value.auxiliaryConsultantId = body.auxiliaryConsultantId;
      }
    }
    const consultantId = value.consultantId;
    const auxiliaryConsultantId = value.auxiliaryConsultantId;
    if (consultantId && auxiliaryConsultantId
      && String(consultantId) === String(auxiliaryConsultantId)) {
      errors.auxiliaryConsultantId = 'The primary and auxiliary consultants must be different';
    }
  }

  for (const field of ['cc', 'cco']) {
    const emails = normalizeEmailList(body[field], field, errors, {
      partial: partial || body[field] === undefined,
    });
    if (emails !== undefined) value[field] = emails;
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
          if (typeof file !== 'string' || file.trim().length > 2048) {
            errors[`archivos.${field}`] = 'Must be a string of at most 2048 characters';
          } else {
            archivos[field] = file.trim();
          }
          continue;
        }

        errors[`archivos.${field}`] = 'Only carpetaPrincipal and carpetaBase belong to an agency';
      }
      value.archivos = archivos;
    }
  }

  if (body.reviewPeriods !== undefined) {
    if (!body.reviewPeriods || typeof body.reviewPeriods !== 'object' || Array.isArray(body.reviewPeriods)) {
      errors.reviewPeriods = 'Must be an object keyed by review category';
    } else {
      const periods = {};
      for (const [category, setting] of Object.entries(body.reviewPeriods)) {
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(category)
          || !setting || typeof setting !== 'object' || Array.isArray(setting)) {
          errors[`reviewPeriods.${category}`] = 'Invalid review category settings';
          continue;
        }
        const { intervalMonths, startPeriod } = setting;
        if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 120) {
          errors[`reviewPeriods.${category}.intervalMonths`] = 'Must be an integer between 1 and 120';
        } else if (typeof startPeriod !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(startPeriod)) {
          errors[`reviewPeriods.${category}.startPeriod`] = 'Must use YYYY-MM format';
        } else {
          periods[category] = { intervalMonths, startPeriod };
        }
        if (Object.keys(setting).some((key) => !['intervalMonths', 'startPeriod'].includes(key))) {
          errors[`reviewPeriods.${category}`] = 'Unknown review setting';
        }
      }
      value.reviewPeriods = periods;
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
    return res.status(409).json({ success: false, message: 'An agency with this information already exists' });
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

const isActiveConsultant = async (consultantId) => User.exists({
  _id: consultantId,
  rol: 'consultor',
  status: 'activo',
});

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
    const period = req.query.period || '';
    if (period && !/^(20\d{2})-(0[1-9]|1[0-2])$/.test(period)) {
      return validationFailure(res, { period: 'Must be a period in YYYY-MM format' });
    }
    if (period) await ensureMonthlyRecalendarization(period);
    const filter = {
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(req.user.rol === 'consultor' ? getAgencyConsultantFilter(req.user._id) : {}),
    };
    const agencies = await Agency.find(filter).sort({ createdAt: -1 }).lean();
    if (period) {
      const records = await AgencyMonthlyFiles.find({
        agencyId: { $in: agencies.map((agency) => agency._id) },
        period,
      }).select('agencyId archivos').lean();
      const filesByAgency = new Map(records.map((record) => [
        String(record.agencyId),
        record.archivos || {},
      ]));
      agencies.forEach((agency) => {
        agency.periodFiles = filesByAgency.get(String(agency._id)) || {};
      });
    }
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
  if ((value.consultantId !== undefined || value.auxiliaryConsultantId !== undefined)
    && !['admin', 'developer'].includes(req.user.rol)) {
    return res.status(403).json({
      success: false,
      message: 'Only administrators can assign the responsible consultant.',
    });
  }
  if (value.reviewPeriods !== undefined && !['admin', 'developer'].includes(req.user?.rol)) {
    return res.status(403).json({ success: false, message: 'Solo los administradores pueden configurar los períodos de revisión.' });
  }

  try {
    if (value.auxiliaryConsultantId && !value.consultantId) {
      return validationFailure(res, {
        consultantId: 'A primary consultant is required when an auxiliary consultant is assigned',
      });
    }
    if (value.consultantId && !await isActiveConsultant(value.consultantId)) {
      return validationFailure(res, { consultantId: 'Active consultant not found' });
    }
    if (value.auxiliaryConsultantId
      && !await isActiveConsultant(value.auxiliaryConsultantId)) {
      return validationFailure(res, { auxiliaryConsultantId: 'Active consultant not found' });
    }
    const agency = await Agency.create(value);
    await notifyAgencyConsultants(agency, {
      title: 'Nueva agencia asignada',
      message: `Se te asignó la agencia ${agency.nombre} como consultor principal. Consulta sus detalles.`,
      auxiliaryTitle: 'Nueva agencia asignada · Auxiliar',
      auxiliaryMessage: `Se te asignó la agencia ${agency.nombre} como consultor auxiliar. Consulta sus detalles.`,
      notificationType: 'agency_assigned',
      actionUrl: `/agencias/${agency._id}`,
      agencyId: agency._id,
      idempotencyKey: `agency:${agency._id}:assigned:${agency.updatedAt.getTime()}`,
    });
    await recordAgencyHistory({
      agencyId: agency._id,
      actor: req.user,
      action: 'agency_created',
      summary: 'Sucursal creada',
      details: { name: agency.nombre },
    });
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
  if (
    ['longitud', 'latitud'].some((field) => Object.hasOwn(req.body || {}, field))
    && req.user?.rol !== 'developer'
  ) {
    return res.status(403).json({
      success: false,
      message: 'Solo un developer puede editar las coordenadas de la agencia.',
    });
  }
  if ((value.consultantId !== undefined || value.auxiliaryConsultantId !== undefined)
    && !['admin', 'developer'].includes(req.user.rol)) {
    return res.status(403).json({
      success: false,
      message: 'Solo los administradores pueden asignar el consultor responsable.',
    });
  }
  if (value.reviewPeriods !== undefined && !['admin', 'developer'].includes(req.user?.rol)) {
    return res.status(403).json({ success: false, message: 'Solo los administradores pueden configurar los períodos de revisión.' });
  }

  try {
    if (value.consultantId && !await isActiveConsultant(value.consultantId)) {
      return validationFailure(res, { consultantId: 'Active consultant not found' });
    }
    if (value.auxiliaryConsultantId
      && !await isActiveConsultant(value.auxiliaryConsultantId)) {
      return validationFailure(res, { auxiliaryConsultantId: 'Active consultant not found' });
    }
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    const nextPrimaryId = value.consultantId !== undefined
      ? value.consultantId
      : agency.consultantId;
    const nextAuxiliaryId = value.auxiliaryConsultantId !== undefined
      ? value.auxiliaryConsultantId
      : agency.auxiliaryConsultantId;
    if (nextAuxiliaryId && !nextPrimaryId) {
      return validationFailure(res, {
        consultantId: 'A primary consultant is required when an auxiliary consultant is assigned',
      });
    }
    if (nextPrimaryId && nextAuxiliaryId
      && String(nextPrimaryId) === String(nextAuxiliaryId)) {
      return validationFailure(res, {
        auxiliaryConsultantId: 'The primary and auxiliary consultants must be different',
      });
    }

    const historyFields = [
      'nombre', 'razonSocial', 'RFC', 'direccion', 'ciudad', 'longitud', 'latitud', 'correo', 'gerente', 'telefonoGerente',
      'seguimiento', 'cc', 'cco', 'entidadFederativa', 'status', 'consultantId', 'auxiliaryConsultantId', 'fileNameCode', 'archivos',
      'marca', 'reviewPeriods',
    ];
    const previousValues = Object.fromEntries(
      historyFields.map((field) => [field, historyValue(getAgencyField(agency, field))]),
    );
    for (const field of [
      'nombre','razonSocial','RFC','direccion', 'ciudad', 'longitud', 'latitud', 'correo', 'gerente', 'telefonoGerente', 'seguimiento',
      'cc', 'cco', 'entidadFederativa', 'status', 'consultantId', 'auxiliaryConsultantId',
      'marca',
      'fileNameCode',
      'reviewPeriods',
    ]) {
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
    if (previousValues.fileNameCode !== agency.fileNameCode || previousValues.marca !== agency.marca) {
      await Promise.all([
        ForReport.updateMany(
          { agencyId: agency._id },
          {
            $set: {
              agencyFileNameCodeSnapshot: agency.fileNameCode || '',
              agencyBrandSnapshot: agency.marca || '',
              'generatedExcel.status': 'not_requested',
              'generatedExcel.reportRevision': 0,
              'generatedExcel.storageProvider': 'drive',
              'generatedExcel.localFileName': '',
              'generatedExcel.driveFileId': '',
              'generatedExcel.downloadFileName': '',
              'generatedExcel.generatedAt': null,
              'generatedExcel.error': '',
              'drive.generatedFolderId': '',
            },
          },
        ),
        AgencyMonthlyFiles.updateMany(
          { agencyId: agency._id, 'archivos.archivo2.mode': 'system' },
          {
            $set: {
              'archivos.archivo2.nombre': '',
              'archivos.archivo2.driveId': '',
              'archivos.archivo2.ruta': '',
              'archivos.archivo2.generatedExcelStatus': 'not_requested',
              'archivos.archivo2.generatedExcelRevision': 0,
              'archivos.archivo2.generatedExcelError': '',
              'archivos.archivo2.generatedExcelTemplateVersion': '',
            },
          },
        ),
      ]);
    }
    const changes = historyFields.flatMap((field) => {
      const from = previousValues[field];
      const to = historyValue(getAgencyField(agency, field));
      return JSON.stringify(from) === JSON.stringify(to)
        ? []
        : [{ field, label: AGENCY_HISTORY_FIELD_LABELS[field], from, to }];
    });
    const notificationKey = `agency:${agency._id}:${agency.updatedAt.getTime()}`;
    const previousAssignments = getAgencyConsultants({
      consultantId: previousValues.consultantId,
      auxiliaryConsultantId: previousValues.auxiliaryConsultantId,
    });
    const nextAssignments = getAgencyConsultants(agency);
    const previousById = new Map(previousAssignments.map((assignment) => [assignment.id, assignment.role]));
    const nextById = new Map(nextAssignments.map((assignment) => [assignment.id, assignment.role]));
    const assignmentsChanged = previousAssignments.some(({ id, role }) => nextById.get(id) !== role)
      || nextAssignments.some(({ id, role }) => previousById.get(id) !== role);
    if (assignmentsChanged) {
      await AgencyMonthlyInspection.updateMany(
        { agencyId: agency._id, reminderSentAt: { $ne: null } },
        { $set: { reminderSentAt: null } },
      );
      await AgencyMonthlyInspection.updateMany(
        {
          agencyId: agency._id,
          authorizationStatus: 'authorized',
          visitStatus: 'scheduled',
          calendarEventId: { $ne: null },
        },
        {
          $set: {
            attendanceStatus: agency.auxiliaryConsultantId ? 'pending' : null,
            attendanceConfirmedBy: null,
            attendanceConfirmedAt: null,
          },
        },
      );
    }
    for (const { id, role } of previousAssignments) {
      if (nextById.has(id)) continue;
      await notifyConsultant({
        consultantId: id,
        title: role === 'auxiliary' ? 'Agencia reasignada · Auxiliar' : 'Agencia reasignada',
        message: `La agencia ${agency.nombre} ya no está asignada a tu cuenta.`,
        notificationType: 'agency_unassigned',
        actionUrl: '/agencias',
        agencyId: agency._id,
        idempotencyKey: `${notificationKey}:unassigned:${role}:${id}`,
      });
    }
    for (const { id, role } of nextAssignments) {
      if (previousById.get(id) === role) continue;
      await notifyConsultant({
        consultantId: id,
        title: role === 'auxiliary' ? 'Nueva agencia asignada · Auxiliar' : 'Nueva agencia asignada',
        message: role === 'auxiliary'
          ? `Se te asignó la agencia ${agency.nombre} como consultor auxiliar. Consulta sus detalles.`
          : `Se te asignó la agencia ${agency.nombre} como consultor principal. Consulta sus detalles.`,
        notificationType: 'agency_assigned',
        actionUrl: `/agencias/${agency._id}`,
        agencyId: agency._id,
        idempotencyKey: `${notificationKey}:assigned:${role}:${id}`,
      });
    }
    if (nextAssignments.length) {
      const relevantChanges = changes.filter(({ field }) => (
        ['nombre', 'direccion', 'gerente', 'telefonoGerente', 'seguimiento', 'status'].includes(field)
      ));
      if (relevantChanges.length) {
        await notifyAgencyConsultants(agency, {
          title: 'Cambios en una agencia asignada',
          message: `Se actualizaron datos de ${agency.nombre} que pueden afectar tu trabajo.`,
          notificationType: 'agency_updated',
          actionUrl: `/agencias/${agency._id}`,
          agencyId: agency._id,
          idempotencyKey: `${notificationKey}:updated`,
        });
      }
    }
    if (changes.length) {
      await recordAgencyHistory({
        agencyId: agency._id,
        actor: req.user,
        action: 'agency_updated',
        summary: `Se actualizaron ${changes.map(({ label }) => label.toLocaleLowerCase()).join(', ')}`,
        details: { changes },
      });
    }
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

    await recordAgencyHistory({
      agencyId: agency._id,
      actor: req.user,
      action: 'agency_deleted',
      summary: 'Sucursal eliminada',
      details: { name: agency.nombre },
    });
    req.auditRecovery = { entity: 'Agency', snapshot: agency.toObject({ depopulate: true }) };
    await Promise.all([
      CalendarEvent.deleteMany({ agencyId: agency._id }),
      AgencyMonthlyInspection.deleteMany({ agencyId: agency._id }),
      AgencyMonthlyFiles.deleteMany({ agencyId: agency._id }),
      AgencyNote.deleteMany({ agencyId: agency._id }),
      AgencyPersonalization.deleteMany({ agencyId: agency._id }),
    ]);
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

  const { year, month, googleAccessToken, folderId } = req.body || {};
  if (!Number.isInteger(year) || year < 2020 || year > 2040) {
    return validationFailure(res, { year: 'Must be an integer between 2020 and 2040' });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return validationFailure(res, { month: 'Must be an integer between 1 and 12' });
  }
  if (typeof googleAccessToken !== 'string' || !googleAccessToken.trim()) {
    return validationFailure(res, { googleAccessToken: 'A Google Drive access token is required' });
  }
  if (folderId !== undefined && (
    typeof folderId !== 'string' || !folderId.trim() || folderId.trim().length > 2048
  )) {
    return validationFailure(res, { folderId: 'Must be a non-empty Drive folder ID of at most 2048 characters' });
  }

  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });

    const auth = await validateDriveToken(googleAccessToken.trim());
    const drive = google.drive({ version: 'v3', auth });
    const update = await refreshAgencyFromDrive(agency, drive, year, month, folderId?.trim());
    try {
      const summary = update.summary || {};
      const period = `${String(month).padStart(2, '0')}/${year}`;
      const note = update.notices?.[0] || '';
      await Notification.create({
        agencyId: agency._id,
        title: 'Resultado de actualización de archivos',
        message: summary.missingRequired
          ? `No se completaron los ${summary.requiredTotal} archivos requeridos para ${agency.nombre} en ${period}.${note ? ` ${note}` : ''}`
          : `Se localizaron los archivos requeridos de ${agency.nombre} para ${period} (${summary.requiredFound}/${summary.requiredTotal}).${note ? ` ${note}` : ''}`,
        severity: summary.missingRequired ? 'medium' : 'low',
        audience: 'all',
        createdBy: req.user._id,
      });
    } catch (notificationError) {
      logEvent('agency_notification_failed', { message: notificationError.message });
    }

    return success(res, update, 'Files refreshed');
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    if (Number(err.code || err.response?.status) === 401) {
      return res.status(401).json({ success: false, message: 'La autorización de Google Drive expiró. Autoriza Drive e inténtalo de nuevo.' });
    }
    if (Number(err.code || err.response?.status) === 403) {
      return res.status(403).json({ success: false, message: 'La cuenta autorizada de Google no tiene acceso a la carpeta seleccionada.' });
    }
    return next(err);
  }
};

const createAgencyRefreshJob = async (req, res, next) => {
  const { agencyIds, year, month, googleAccessToken } = req.body || {};
  if (
    !Array.isArray(agencyIds) || agencyIds.length === 0 || agencyIds.length > 500 ||
    !agencyIds.every((id) => typeof id === 'string' && mongoose.isValidObjectId(id)) ||
    !Number.isInteger(year) || year < 2020 || year > 2040 ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    typeof googleAccessToken !== 'string' || !googleAccessToken.trim()
  ) {
    return res.status(400).json({ message: 'Selecciona agencias, período y autorización de Google Drive válidos.' });
  }

  try {
    const activeJob = await AgencyRefreshJob.exists({
      owner: req.user._id,
      status: { $in: ['queued', 'processing'] },
    });
    if (activeJob) {
      return res.status(409).json({ message: 'Ya tienes un proceso de agencias en curso.' });
    }

    await validateDriveToken(googleAccessToken.trim());
    const selectedIds = [...new Set(agencyIds.map(String))];
    const agencies = await Agency.find({ _id: { $in: selectedIds } }).select('_id');
    if (agencies.length !== selectedIds.length) {
      return res.status(400).json({ message: 'Una o más agencias ya no existen. Actualiza la lista e inténtalo de nuevo.' });
    }

    const job = await AgencyRefreshJob.create({
      owner: req.user._id,
      ownerEmail: req.user.correo,
      year,
      month,
      agencyIds: selectedIds,
      total: selectedIds.length,
      encryptedGoogleAccessToken: encryptGoogleToken(googleAccessToken.trim()),
    });
    kickAgencyRefreshJobWorker();
    return res.status(202).json(serializeAgencyRefreshJob(job));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (Number(error.code || error.response?.status) === 401) {
      return res.status(401).json({ message: 'La autorización de Google Drive expiró. Autoriza Drive e inténtalo de nuevo.' });
    }
    return next(error);
  }
};

const getActiveAgencyRefreshJob = async (req, res, next) => {
  try {
    const job = await AgencyRefreshJob.findOne({
      owner: req.user._id,
      jobType: 'refresh',
      status: { $in: ['queued', 'processing'] },
    }).sort({ createdAt: -1 });
    return res.json(job ? serializeAgencyRefreshJob(job) : null);
  } catch (error) {
    return next(error);
  }
};

const createAgencyIntegrityJob = async (req, res, next) => {
  const { agencyIds, year, month, googleAccessToken } = req.body || {};
  if (
    !Array.isArray(agencyIds) || agencyIds.length === 0 || agencyIds.length > 500 ||
    !agencyIds.every((id) => typeof id === 'string' && mongoose.isValidObjectId(id)) ||
    !Number.isInteger(year) || year < 2020 || year > 2040 ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    typeof googleAccessToken !== 'string' || !googleAccessToken.trim()
  ) {
    return res.status(400).json({ message: 'Selecciona agencias, período y autorización de Google Drive válidos.' });
  }

  try {
    const activeJob = await AgencyRefreshJob.exists({
      owner: req.user._id,
      status: { $in: ['queued', 'processing'] },
    });
    if (activeJob) return res.status(409).json({ message: 'Ya tienes un proceso de agencias en curso.' });

    await validateDriveToken(googleAccessToken.trim());
    const selectedIds = [...new Set(agencyIds.map(String))];
    const agencies = await Agency.find({ _id: { $in: selectedIds } }).select('_id');
    if (agencies.length !== selectedIds.length) {
      return res.status(400).json({ message: 'Una o más agencias ya no existen. Actualiza la lista e inténtalo de nuevo.' });
    }

    const job = await AgencyRefreshJob.create({
      owner: req.user._id,
      ownerEmail: req.user.correo,
      jobType: 'integrity',
      year,
      month,
      agencyIds: selectedIds,
      total: selectedIds.length,
      encryptedGoogleAccessToken: encryptGoogleToken(googleAccessToken.trim()),
    });
    kickAgencyRefreshJobWorker();
    return res.status(202).json(serializeAgencyRefreshJob(job));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (Number(error.code || error.response?.status) === 401) {
      return res.status(401).json({ message: 'La autorización de Google Drive expiró. Autoriza Drive e inténtalo de nuevo.' });
    }
    return next(error);
  }
};

const getActiveAgencyIntegrityJob = async (req, res, next) => {
  try {
    const job = await AgencyRefreshJob.findOne({
      owner: req.user._id,
      jobType: 'integrity',
      status: { $in: ['queued', 'processing'] },
    }).sort({ createdAt: -1 });
    return res.json(job ? serializeAgencyRefreshJob(job) : null);
  } catch (error) {
    return next(error);
  }
};

const getAgencyMaintenanceHistory = async (req, res, next) => {
  const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
  const skip = req.query.skip === undefined ? 0 : Number(req.query.skip);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return validationFailure(res, { limit: 'Must be an integer between 1 and 100' });
  }
  if (!Number.isInteger(skip) || skip < 0 || skip > 100000) {
    return validationFailure(res, { skip: 'Must be an integer between 0 and 100000' });
  }
  try {
    const jobs = await AgencyRefreshJob.find({
      owner: req.user._id,
      status: { $in: ['completed', 'completed_with_issues', 'failed'] },
    }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit);
    return res.json(jobs.map(serializeAgencyRefreshJob));
  } catch (error) {
    return next(error);
  }
};

const getAgencyRefreshJob = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.jobId)) {
      return res.status(404).json({ message: 'No se encontró la actualización.' });
    }
    const job = await AgencyRefreshJob.findOne({ _id: req.params.jobId, owner: req.user._id });
    if (!job) return res.status(404).json({ message: 'No se encontró la actualización.' });
    return res.json(serializeAgencyRefreshJob(job));
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAgencySearchPeriod,
  updateAgencySearchPeriod,
  getAgencyEmails,
  getAgencies,
  getAgencyById,
  createAgency,
  updateAgency,
  deleteAgency,
  learnAgencyPattern,
  refreshAgencyFiles,
  createAgencyRefreshJob,
  getActiveAgencyRefreshJob,
  createAgencyIntegrityJob,
  getActiveAgencyIntegrityJob,
  getAgencyMaintenanceHistory,
  getAgencyRefreshJob,
  validateAgencyInput,
  removeNullAgencyFileSlots,
};