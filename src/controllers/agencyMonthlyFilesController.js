'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const { success } = require('../utils/response');
const { recordAgencyHistory } = require('../services/agencyHistory');
const { TEMPLATE_VERSION } = require('../formatosGeneradores/for/services/forReportExcelGenerator');
const { TEMPLATE_VERSION: REP_TEMPLATE_VERSION } = require('../formatosGeneradores/rep/services/repExcelGenerator');
const { TEMPLATE_VERSION: REV_TEMPLATE_VERSION } = require('../formatosGeneradores/rev/services/revExcelGenerator');

const FILE_FIELDS = new Set(['archivo1', 'archivo2', 'archivo3', 'archivo4']);
const FILE_PROPERTIES = new Set([
  'nombre', 'ruta', 'driveId', 'pseudoPath', 'path', 'sizeBytes', 'mimeType', 'modifiedTime',
  'mode', 'systemReportId', 'generatedExcelStatus', 'reportRevision',
  'generatedExcelRevision', 'generatedExcelTemplateVersion', 'generatedExcelError',
  'generatedAnxStatus', 'generatedAnxError', 'generatedAnxRevision',
  'systemNombre', 'systemRuta', 'systemDriveId',
]);
const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const GENERATED_STATUSES = ['not_requested', 'queued', 'processing', 'ready', 'failed'];
const SYSTEM_REFERENCE_PROPERTIES = [
  'systemReportId', 'generatedExcelStatus', 'generatedExcelError',
  'generatedExcelTemplateVersion', 'reportRevision', 'generatedExcelRevision',
  'generatedAnxStatus', 'generatedAnxError', 'generatedAnxRevision',
  'systemNombre', 'systemRuta', 'systemDriveId',
];

function isValidSystemReportId(key, reportId) {
  const prefix = { archivo1: 'REP', archivo2: 'FOR', archivo3: 'REP', archivo4: 'REV' }[key];
  return typeof reportId === 'string' && new RegExp(`^${prefix}-[a-f\\d-]{36}$`, 'i').test(reportId);
}

function addSystemReferenceErrors(key, file, errors) {
  if (!isValidSystemReportId(key, file.systemReportId)) {
    errors[`archivos.${key}.systemReportId`] = 'A valid system report ID is required';
  }
  if (file.generatedExcelStatus !== undefined && !GENERATED_STATUSES.includes(file.generatedExcelStatus)) {
    errors[`archivos.${key}.generatedExcelStatus`] = 'Must be not_requested, queued, processing, ready, or failed';
  }
  for (const property of ['reportRevision', 'generatedExcelRevision', 'generatedAnxRevision']) {
    if (file[property] !== undefined && (!Number.isInteger(file[property]) || file[property] < 0)) {
      errors[`archivos.${key}.${property}`] = 'Must be a non-negative integer';
    }
  }
  for (const [property, maxLength] of [
    ['generatedExcelError', 1000],
    ['generatedExcelTemplateVersion', 30],
    ['generatedAnxError', 1000],
    ['systemNombre', 255],
    ['systemRuta', 2048],
    ['systemDriveId', 2048],
  ]) {
    if (file[property] !== undefined
      && (typeof file[property] !== 'string' || file[property].length > maxLength)) {
      errors[`archivos.${key}.${property}`] = `Must be a string of at most ${maxLength} characters`;
    }
  }
  if (file.generatedAnxStatus !== undefined && !GENERATED_STATUSES.includes(file.generatedAnxStatus)) {
    errors[`archivos.${key}.generatedAnxStatus`] = 'Must be not_requested, queued, processing, ready, or failed';
  }
}

function serializeMonthlyRecord(record, agency) {
  if (!record) return null;
  const serialized = {
    ...record,
    carpetaPrincipal: agency.archivos?.carpetaPrincipal || '',
    carpetaBase: agency.archivos?.carpetaBase || '',
  };
  if (serialized.archivos?.archivo2?.systemReportId) {
    serialized.archivos.archivo2.currentGeneratedExcelTemplateVersion = TEMPLATE_VERSION;
  }
  if (serialized.archivos?.archivo3?.systemReportId) {
    serialized.archivos.archivo3.currentGeneratedExcelTemplateVersion = REP_TEMPLATE_VERSION;
  }
  if (serialized.archivos?.archivo4?.systemReportId) {
    serialized.archivos.archivo4.currentGeneratedExcelTemplateVersion = REV_TEMPLATE_VERSION;
  }
  return serialized;
}

function validationFailure(res, errors) {
  return res.status(400).json({ success: false, message: 'Validation failed', errors });
}

function preserveSystemGeneratedFiles(existingFiles = {}, requestedFiles = {}) {
  const result = { ...requestedFiles };
  for (const key of FILE_FIELDS) {
    const current = existingFiles[key];
    if (!current?.systemReportId) continue;
    const requested = result[key];
    if (!requested || requested.mode !== 'drive') {
      result[key] = current;
      continue;
    }
    const systemReference = Object.fromEntries(SYSTEM_REFERENCE_PROPERTIES
      .filter((property) => current[property] !== undefined)
      .map((property) => [property, current[property]]));
    if (current.mode === 'system') {
      systemReference.systemNombre = current.systemNombre || current.nombre || '';
      systemReference.systemRuta = current.systemRuta || current.ruta || '';
      systemReference.systemDriveId = current.systemDriveId || current.driveId || '';
    }
    result[key] = { ...requested, ...systemReference, mode: 'drive' };
  }
  return result;
}

function validateMonthlyFiles(body, period) {
  const errors = {};
  const match = PERIOD_PATTERN.exec(period);
  if (!match || Number(match[1]) < 2020 || Number(match[1]) > 2040) {
    errors.period = 'Must be a period between 2020-01 and 2040-12';
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { ...errors, body: 'A JSON object is required' } };
  }

  const value = {};
  for (const key of Object.keys(body)) {
    if (!['carpetaPrincipal', 'carpetaBase', 'archivos'].includes(key)) {
      errors[key] = 'Unknown field';
    }
  }
  for (const key of ['carpetaPrincipal', 'carpetaBase']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string' || body[key].trim().length > 2048) {
      errors[key] = 'Must be a string of at most 2048 characters';
    } else {
      value[key] = body[key].trim();
    }
  }

  if (!body.archivos || typeof body.archivos !== 'object' || Array.isArray(body.archivos)) {
    errors.archivos = 'Must be an object';
  } else {
    value.archivos = {};
    for (const key of FILE_FIELDS) {
      if (!Object.hasOwn(body.archivos, key)) {
        errors[`archivos.${key}`] = 'This file slot is required; use null when absent';
      }
    }
    for (const [key, file] of Object.entries(body.archivos)) {
      if (!FILE_FIELDS.has(key)) {
        errors[`archivos.${key}`] = 'Unknown file type';
        continue;
      }
      if (file === null) {
        continue;
      }
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        errors[`archivos.${key}`] = 'Must be an object or null';
        continue;
      }

      const mode = file.mode || 'drive';
      if (!['drive', 'system'].includes(mode)) {
        errors[`archivos.${key}.mode`] = 'Must be drive or system';
        continue;
      }

      for (const property of Object.keys(file)) {
        if (!FILE_PROPERTIES.has(property)) {
          errors[`archivos.${key}.${property}`] = 'Unknown field';
        }
      }
      if (mode === 'drive') {
        if (typeof file.nombre !== 'string' || !file.nombre.trim() || file.nombre.trim().length > 255) {
          errors[`archivos.${key}.nombre`] = 'A name of at most 255 characters is required';
        }
        if (typeof file.ruta !== 'string' || !file.ruta.trim() || file.ruta.trim().length > 2048) {
          errors[`archivos.${key}.ruta`] = 'A path of at most 2048 characters is required';
        }
        if (typeof file.driveId !== 'string' || !file.driveId.trim() || file.driveId.trim().length > 2048) {
          errors[`archivos.${key}.driveId`] = 'A Drive ID of at most 2048 characters is required';
        }
        if (file.systemReportId) addSystemReferenceErrors(key, file, errors);
        else if (SYSTEM_REFERENCE_PROPERTIES.some((property) => file[property] !== undefined)) {
          errors[`archivos.${key}.systemReportId`] = 'A valid system report ID is required';
        }
      } else {
        addSystemReferenceErrors(key, file, errors);
      }
      if (file.pseudoPath !== undefined && (
        !Array.isArray(file.pseudoPath) ||
        file.pseudoPath.length > 100 ||
        file.pseudoPath.some((part) => typeof part !== 'string' || !part.trim() || part.trim().length > 255)
      )) {
        errors[`archivos.${key}.pseudoPath`] = 'Must be an array of up to 100 non-empty path segments';
      }
      if (file.path !== undefined && (
        typeof file.path !== 'string' || !file.path.trim() || file.path.trim().length > 4096
      )) {
        errors[`archivos.${key}.path`] = 'Must be a non-empty string of at most 4096 characters';
      }
      if (file.sizeBytes !== undefined && file.sizeBytes !== null && (
        !Number.isFinite(file.sizeBytes) || file.sizeBytes < 0
      )) {
        errors[`archivos.${key}.sizeBytes`] = 'Must be a non-negative number or null';
      }
      if (file.mimeType !== undefined && (
        typeof file.mimeType !== 'string' || file.mimeType.length > 255
      )) {
        errors[`archivos.${key}.mimeType`] = 'Must be a string of at most 255 characters';
      }
      if (file.modifiedTime !== undefined && file.modifiedTime !== null && Number.isNaN(Date.parse(file.modifiedTime))) {
        errors[`archivos.${key}.modifiedTime`] = 'Must be a valid date or null';
      }

      if (mode === 'system') {
        value.archivos[key] = {
          mode,
          systemReportId: file.systemReportId,
          nombre: typeof file.nombre === 'string' ? file.nombre.trim().slice(0, 255) : '',
          generatedExcelStatus: file.generatedExcelStatus || 'not_requested',
          driveId: typeof file.driveId === 'string' ? file.driveId.trim().slice(0, 2048) : '',
          ruta: typeof file.ruta === 'string' ? file.ruta.trim().slice(0, 2048) : '',
          reportRevision: Number.isInteger(file.reportRevision) ? file.reportRevision : 0,
          generatedExcelRevision: Number.isInteger(file.generatedExcelRevision) ? file.generatedExcelRevision : 0,
          generatedAnxStatus: file.generatedAnxStatus || 'not_requested',
          generatedAnxError: typeof file.generatedAnxError === 'string'
            ? file.generatedAnxError.trim().slice(0, 1000)
            : '',
          generatedAnxRevision: Number.isInteger(file.generatedAnxRevision) ? file.generatedAnxRevision : 0,
          generatedExcelTemplateVersion: typeof file.generatedExcelTemplateVersion === 'string'
            ? file.generatedExcelTemplateVersion.trim().slice(0, 30)
            : '',
          periodYear: Number(match?.[1]),
          periodMonth: Number(match?.[2]),
        };
      } else if (
        typeof file.nombre === 'string' && file.nombre.trim() && file.nombre.trim().length <= 255 &&
        typeof file.ruta === 'string' && file.ruta.trim() && file.ruta.trim().length <= 2048 &&
        typeof file.driveId === 'string' && file.driveId.trim() && file.driveId.trim().length <= 2048
      ) {
        value.archivos[key] = {
          mode: 'drive',
          nombre: file.nombre.trim(),
          ruta: file.ruta.trim(),
          driveId: file.driveId.trim(),
          ...(file.pseudoPath ? { pseudoPath: file.pseudoPath.map((part) => part.trim()) } : {}),
          ...(file.path ? { path: file.path.trim() } : {}),
          ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
          ...(file.mimeType !== undefined ? { mimeType: file.mimeType.trim() } : {}),
          ...(file.modifiedTime !== undefined ? { modifiedTime: file.modifiedTime } : {}),
          ...(file.systemReportId ? Object.fromEntries(SYSTEM_REFERENCE_PROPERTIES
            .filter((property) => file[property] !== undefined)
            .map((property) => [property, file[property]])) : {}),
          periodYear: Number(match?.[1]),
          periodMonth: Number(match?.[2]),
        };
      }
    }
  }
  return { errors, value };
}

async function getAgencyMonthlyFiles(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Agency not found' });
  }
  const periodMatch = PERIOD_PATTERN.exec(req.params.period);
  if (!periodMatch || Number(periodMatch[1]) < 2020 || Number(periodMatch[1]) > 2040) {
    return validationFailure(res, { period: 'Must be a period between 2020-01 and 2040-12' });
  }
  try {
    const agency = await Agency.findById(req.params.id).select('archivos').lean();
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    const record = await AgencyMonthlyFiles.findOne({
      agencyId: req.params.id,
      period: req.params.period,
    }).lean();
    return success(res, { record: serializeMonthlyRecord(record, agency) }, 'Monthly files fetched');
  } catch (error) {
    return next(error);
  }
}

async function saveAgencyMonthlyFiles(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Agency not found' });
  }
  const { errors, value } = validateMonthlyFiles(req.body, req.params.period);
  if (Object.keys(errors).length) return validationFailure(res, errors);

  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    const previousRecord = await AgencyMonthlyFiles.findOne({
      agencyId: agency._id,
      period: req.params.period,
    }).lean();
    const archivos = preserveSystemGeneratedFiles(previousRecord?.archivos, value.archivos);
    const record = await AgencyMonthlyFiles.findOneAndUpdate(
      { agencyId: agency._id, period: req.params.period },
      {
        $set: {
          archivos,
          updatedBy: req.user._id,
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    const folderUpdates = {};
    for (const key of ['carpetaPrincipal', 'carpetaBase']) {
      if (value[key] !== undefined) folderUpdates[`archivos.${key}`] = value[key];
    }
    if (Object.keys(folderUpdates).length) {
      await Agency.updateOne({ _id: agency._id }, { $set: folderUpdates }, { runValidators: true });
      Object.assign(agency.archivos || (agency.archivos = {}), {
        ...(value.carpetaPrincipal !== undefined ? { carpetaPrincipal: value.carpetaPrincipal } : {}),
        ...(value.carpetaBase !== undefined ? { carpetaBase: value.carpetaBase } : {}),
      });
    }
    if (JSON.stringify(previousRecord?.archivos || {}) !== JSON.stringify(record.archivos || {})) {
      await recordAgencyHistory({
        agencyId: agency._id,
        actor: req.user,
        action: 'agency_updated',
        summary: `Se actualizaron los archivos asociados de ${req.params.period}`,
        details: {
          period: req.params.period,
          changes: [{
            field: `archivos.${req.params.period}`,
            label: `Archivos asociados ${req.params.period}`,
            from: previousRecord?.archivos || {},
            to: record.archivos || {},
          }],
        },
      });
    }
    return success(res, serializeMonthlyRecord(record.toObject(), agency), 'Monthly files saved');
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAgencyMonthlyFiles,
  saveAgencyMonthlyFiles,
  validateMonthlyFiles,
  serializeMonthlyRecord,
  preserveSystemGeneratedFiles,
};
