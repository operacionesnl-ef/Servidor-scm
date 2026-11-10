'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Agency = require('../../../models/Agency');
const RevReport = require('../models/RevReport');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const { syncRevReportMonthlyFile } = require('../services/revMonthlyFileSync');
const { kickRevExcelWorker } = require('../services/revExcelWorker');
const { enqueueGeneration } = require('../../services/generationQueue');
const { buildDownloadFileName, TEMPLATE_VERSION } = require('../services/revExcelGenerator');
const {
  CHECK_FIELDS,
  CHECK_VALUES,
  STATUS_OPTIONS,
  TYPE_FIELDS,
} = require('../revOptions');

const ALLOWED_ROLES = new Set(['admin', 'developer', 'consultor']);
const ADMIN_ROLES = new Set(['admin', 'developer']);
const REPORT_ID_PATTERN = /^REV-[a-f\d-]{36}$/i;
const EXTINGUISHER_TEXT_FIELDS = new Set([
  'fecha_carga', 'fecha_vencimiento', 'observaciones',
]);
const EXTINGUISHER_FIELDS = new Set([
  ...TYPE_FIELDS,
  ...CHECK_FIELDS,
  ...EXTINGUISHER_TEXT_FIELDS,
  'capacidad', 'status', 'ubicacion',
]);

class RevRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respond(error, res, next) {
  if (error instanceof RevRequestError) return res.status(error.status).json({ success: false, message: error.message });
  return next(error);
}

async function getAccessibleAgency(user, agencyId) {
  if (!mongoose.isValidObjectId(agencyId)) throw new RevRequestError(400, 'El identificador de agencia no es válido.');
  const role = String(user?.rol || '').trim().toLowerCase();
  if (!ALLOWED_ROLES.has(role)) throw new RevRequestError(403, 'Tu cuenta no puede acceder a REV.');
  const filter = { _id: agencyId };
  if (role === 'consultor') filter.consultantId = user._id;
  const agency = await Agency.findOne(filter)
    .select('_id nombre razonSocial direccion brand marca fileNameCode consultantId')
    .lean();
  if (!agency) throw new RevRequestError(404, 'No se encontró la agencia o no tienes acceso asignado.');
  return agency;
}

function canEdit(user) {
  const role = String(user?.rol || '').trim().toLowerCase();
  return ADMIN_ROLES.has(role) || (role === 'consultor' && user?.canEditForReports === true);
}

async function loadRevReport(req, res, next, reportId) {
  try {
    if (!REPORT_ID_PATTERN.test(reportId || '')) return res.status(404).json({ success: false, message: 'No se encontró el REV.' });
    const report = await RevReport.findOne({ reportId });
    if (!report) return res.status(404).json({ success: false, message: 'No se encontró el REV.' });
    await getAccessibleAgency(req.user, report.agencyId);
    req.revReport = report;
    return next();
  } catch (error) {
    return respond(error, res, next);
  }
}

function validateData(body) {
  const errors = [];
  const date = body?.generalData?.inspectionDate;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    errors.push('generalData.inspectionDate debe tener formato AAAA-MM-DD.');
  }
  if (body?.generalData?.responsible !== undefined
    && (typeof body.generalData.responsible !== 'string' || body.generalData.responsible.length > 200)) {
    errors.push('generalData.responsible debe ser texto de hasta 200 caracteres.');
  }
  if (!Array.isArray(body?.extinguishers) || body.extinguishers.length > 80) {
    errors.push('extinguishers debe ser una lista de hasta 80 extintores.');
  } else {
    body.extinguishers.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`extinguishers[${index}] debe ser un objeto.`);
        return;
      }
      let selectedTypeCount = 0;
      for (const [field, value] of Object.entries(entry)) {
        if (!EXTINGUISHER_FIELDS.has(field)) {
          errors.push(`extinguishers[${index}].${field} no es un campo editable.`);
        } else if (field === 'capacidad') {
          if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
            errors.push(`extinguishers[${index}].capacidad debe ser un número mayor o igual a cero.`);
          }
        } else if (TYPE_FIELDS.includes(field)) {
          if (value !== '' && value !== '1') {
            errors.push(`extinguishers[${index}].${field} solo puede estar vacío o tener valor 1.`);
          }
          if (value === '1') selectedTypeCount += 1;
        } else if (CHECK_FIELDS.includes(field)) {
          if (typeof value !== 'string' || !CHECK_VALUES.includes(value)) {
            errors.push(`extinguishers[${index}].${field} debe ser 1, 0, NA, NT, 2 o NR.`);
          }
        } else if (field === 'status') {
          if (typeof value !== 'string' || !STATUS_OPTIONS.includes(value)) {
            errors.push(`extinguishers[${index}].status no es una opción válida.`);
          }
        } else if (field === 'ubicacion') {
          if (typeof value !== 'string' || value.length > 500) {
            errors.push('extinguishers[' + index + '].ubicacion debe ser texto de hasta 500 caracteres.');
          }
        } else if (typeof value !== 'string'
          || value.length > (field === 'observaciones' ? 2000 : 500)) {
          errors.push(`extinguishers[${index}].${field} debe ser texto de hasta ${field === 'observaciones' ? 2000 : 500} caracteres.`);
        }
      }
      if (selectedTypeCount > 1) errors.push(`extinguishers[${index}] solo puede tener un tipo de extintor.`);
    });
  }
  return errors;
}

function serialize(report) {
  const value = report.toObject ? report.toObject() : report;
  delete value.idempotencyKey;
  return value;
}

async function createRevReport(req, res, next) {
  try {
    const errors = validateData(req.body);
    if (errors.length) throw new RevRequestError(400, errors.join(' '));
    if (!canEdit(req.user)) throw new RevRequestError(403, 'No tienes permiso para crear un REV.');
    const agency = await getAccessibleAgency(req.user, req.body.agencyId);
    const report = await RevReport.create({
      reportId: `REV-${crypto.randomUUID()}`,
      idempotencyKey: crypto.randomUUID(),
      agencyId: agency._id,
      agencyNameSnapshot: agency.nombre,
      agencyLegalNameSnapshot: agency.razonSocial || '',
      agencyAddressSnapshot: agency.direccion || '',
      agencyBrandSnapshot: String(agency.brand || agency.marca || '').trim(),
      agencyFileNameCodeSnapshot: agency.fileNameCode || '',
      generalData: {
        inspectionDate: req.body.generalData.inspectionDate,
        responsible: req.body.generalData.responsible || '',
      },
      extinguishers: req.body.extinguishers.map((entry, index) => ({
        ...entry,
        n: index + 1,
        observaciones: entry.observaciones?.trim() || 'Sin Observaciones',
        ubicacion: entry.ubicacion || '',
      })),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await syncRevReportMonthlyFile(report);
    return res.status(201).json({ success: true, data: serialize(report) });
  } catch (error) {
    return respond(error, res, next);
  }
}

async function listRevReports(req, res, next) {
  try {
    const agency = await getAccessibleAgency(req.user, req.query.agencyId);
    const filter = { agencyId: agency._id };
    if (req.query.inspectionDate) filter['generalData.inspectionDate'] = req.query.inspectionDate;
    const reports = await RevReport.find(filter).sort({ 'generalData.inspectionDate': -1, createdAt: -1 }).limit(200);
    return res.json({ success: true, data: reports.map(serialize) });
  } catch (error) {
    return respond(error, res, next);
  }
}

async function getRevReport(req, res) {
  return res.json({ success: true, data: serialize(req.revReport) });
}

async function updateRevReport(req, res, next) {
  try {
    const report = req.revReport;
    if (!canEdit(req.user)) throw new RevRequestError(403, 'No tienes permiso para modificar este REV.');
    if (req.body.expectedRevision !== report.revision) throw new RevRequestError(409, 'El REV cambió; actualiza los datos antes de guardar.');
    const errors = validateData({ ...req.body, agencyId: report.agencyId });
    if (errors.length) throw new RevRequestError(400, errors.join(' '));
    report.generalData = {
      inspectionDate: req.body.generalData.inspectionDate,
      responsible: req.body.generalData.responsible || '',
    };
    report.extinguishers = req.body.extinguishers.map((entry, index) => ({
      ...entry,
      n: index + 1,
      observaciones: entry.observaciones?.trim() || 'Sin Observaciones',
      ubicacion: entry.ubicacion || '',
    }));
    report.revision += 1;
    report.updatedBy = req.user._id;
    report.generatedExcel.status = 'not_requested';
    report.generatedExcel.reportRevision = 0;
    report.generatedExcel.driveFileId = '';
    report.generatedExcel.error = '';
    await report.save();
    await syncRevReportMonthlyFile(report);
    return res.json({ success: true, data: serialize(report) });
  } catch (error) {
    return respond(error, res, next);
  }
}

async function queueRevExcel(req, res, next) {
  try {
    const report = req.revReport;
    if (!canEdit(req.user)) throw new RevRequestError(403, 'No tienes permiso para generar el Excel REV.');
    if (req.body.expectedRevision !== report.revision) throw new RevRequestError(409, 'El REV cambió; actualiza los datos antes de generar.');
    report.generatedExcel = {
      status: 'queued',
      reportRevision: report.revision,
      templateVersion: TEMPLATE_VERSION,
      driveFileId: '',
      downloadFileName: buildDownloadFileName(report),
      queuedAt: new Date(),
      startedAt: null,
      generatedAt: null,
      error: '',
    };
    await report.save();
    await enqueueGeneration({
      type: 'REV',
      entityId: report._id,
      reportId: report.reportId,
      revision: report.revision,
      userId: req.user._id,
    });
    await syncRevReportMonthlyFile(report);
    kickRevExcelWorker();
    return res.status(202).json({ success: true, data: { generatedExcel: report.generatedExcel } });
  } catch (error) {
    return respond(error, res, next);
  }
}

async function getRevExcelStatus(req, res) {
  return res.json({ success: true, data: { generatedExcel: req.revReport.generatedExcel } });
}

async function downloadRevExcel(req, res, next) {
  try {
    const report = req.revReport;
    const generated = report.generatedExcel;
    if (generated.status !== 'ready' || generated.reportRevision !== report.revision
      || generated.templateVersion !== TEMPLATE_VERSION || !generated.driveFileId) {
      throw new RevRequestError(404, 'No hay un Excel validado para la revisión actual del REV.');
    }
    const response = await createGoogleDriveClient().files.get(
      { fileId: generated.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(generated.downloadFileName || 'REV-EXT.xlsx')}"`,
    });
    response.data.on('error', (error) => res.destroy(error));
    return response.data.pipe(res);
  } catch (error) {
    return respond(error, res, next);
  }
}

module.exports = {
  createRevReport,
  downloadRevExcel,
  getRevExcelStatus,
  getRevReport,
  listRevReports,
  loadRevReport,
  queueRevExcel,
  updateRevReport,
};
