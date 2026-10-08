const mongoose = require('mongoose');
const { google } = require('googleapis');
const Agency = require('../models/Agency');
const AgencyRefreshJob = require('../models/AgencyRefreshJob');
const GlobalSetting = require('../models/GlobalSetting');
const Notification = require('../models/Notification');
const SentEmail = require('../models/SentEmail');
const { success } = require('../utils/response');
const { updateDrivePattern } = require('../utils/drivePatternUtils');
const { FILE_TYPES } = require('../utils/agencyFileRefreshUtils');
const { encryptGoogleToken } = require('../utils/mailJobCrypto');
const { kickAgencyRefreshJobWorker } = require('../services/agencyRefreshJobWorker');
const { refreshAgencyFromDrive } = require('../services/agencyDriveRefresh');
const { normalizeEmailList } = require('../utils/emailList');
const { getMexicoPeriod } = require('../utils/notificationUtils');
const { logEvent } = require('../utils/consoleLogger');

const AGENCY_SEARCH_PERIOD_SETTING = 'agency-search-period';

const serializeAgencySearchPeriod = (setting) => ({
  year: setting.year,
  month: setting.month,
});

const getAgencySearchPeriod = async (req, res, next) => {
  try {
    const fallbackPeriod = getMexicoPeriod();
    const setting = await GlobalSetting.findOneAndUpdate(
      { _id: AGENCY_SEARCH_PERIOD_SETTING },
      { $setOnInsert: fallbackPeriod },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    return res.json(serializeAgencySearchPeriod(setting));
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
  'correo',
  'cc',
  'cco',
  'entidadFederativa',
  'status',
  'archivos',
]);
const ALLOWED_STATUSES = new Set(['activa', 'inactiva', 'suspendida']);
const FILE_FIELDS = new Set(['archivo1', 'archivo2', 'archivo3', 'archivo4']);
const FILE_CODES = { archivo1: 'ANX', archivo2: 'FOR', archivo3: 'REP', archivo4: 'REV' };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

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
          archivos: result.files || {},
        },
        missingKeys: result.missingKeys,
        files: result.files || {},
        selectedFiles: {},
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

    for (const field of ['nombre', 'correo', 'cc', 'cco', 'entidadFederativa', 'status']) {
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
      const foundFiles = update.summary?.found || 0;
      await Notification.create({
        title: 'Resultado de actualización de archivos',
        message: foundFiles
          ? `Se actualizaron ${foundFiles} de 4 archivos de ${agency.nombre} para ${String(month).padStart(2, '0')}/${year}.`
          : `No se encontraron archivos actualizables para ${agency.nombre} en ${String(month).padStart(2, '0')}/${year}.`,
        severity: foundFiles === 4 ? 'low' : 'medium',
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
};