'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Agency = require('../../../models/Agency');
const CalendarEvent = require('../../../models/CalendarEvent');
const RepReport = require('../models/RepReport');
const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const { getDriveFileMetadata } = require('../../../services/googleDriveService');
const { processForReportImage, ImageProcessingError } = require('../../for/services/forReportImageProcessor');
const {
  ensureRepImageFolder,
  getBrandLogo,
  uploadRepImageToDrive,
} = require('../services/repDriveStorage');
const { syncRepReportMonthlyFile } = require('../services/repMonthlyFileSync');
const { kickRepExcelWorker } = require('../services/repExcelWorker');
const {
  RepExcelError,
  TEMPLATE_VERSION,
} = require('../services/repExcelGenerator');
const { serializeRepReport, validateRepPayload, isValidDate } = require('../services/repService');

const ACCESS_ROLES = new Set(['admin', 'developer', 'consultor']);
const ADMIN_ROLES = new Set(['admin', 'developer']);
const REPORT_ID_PATTERN = /^REP-[a-f\d-]{36}$/i;
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MEXICO_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const MEXICO_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Mexico_City',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function getLocalDateTime(date) {
  const parts = Object.fromEntries(MEXICO_DATE_FORMATTER.formatToParts(date)
    .map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: MEXICO_TIME_FORMATTER.format(date),
  };
}

class RepRequestError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function respondError(error, res, next) {
  if (error instanceof RepRequestError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
      ...(error.details ? { errors: error.details } : {}),
    });
  }
  return next(error);
}

async function getAccessibleAgency(user, agencyId) {
  if (!mongoose.isValidObjectId(agencyId)) throw new RepRequestError(400, 'El identificador de agencia no es válido.');
  const role = String(user?.rol || '').trim().toLowerCase();
  if (!ACCESS_ROLES.has(role)) throw new RepRequestError(403, 'Tu cuenta no puede acceder a REP.');
  const filter = { _id: agencyId };
  if (role === 'consultor') filter.consultantId = user._id;
  const agency = await Agency.findOne(filter)
    .select('_id nombre razonSocial direccion entidadFederativa marca consultantId')
    .lean();
  if (!agency) throw new RepRequestError(404, 'No se encontró la agencia o no tienes acceso asignado.');
  return agency;
}

function canEditReport(user, report) {
  const role = String(user?.rol || '').trim().toLowerCase();
  return ADMIN_ROLES.has(role) || (role === 'consultor' && user?.canEditForReports === true);
}

function requireCanEdit(user, report) {
  if (!canEditReport(user, report)) {
    throw new RepRequestError(403, 'Solo un administrador o un consultor autorizado puede modificar este REP.');
  }
}

async function loadRepReport(req, res, next, reportId) {
  try {
    if (!REPORT_ID_PATTERN.test(reportId || '')) {
      return res.status(404).json({ success: false, message: 'No se encontró el REP.' });
    }
    const report = await RepReport.findOne({ reportId });
    if (!report) return res.status(404).json({ success: false, message: 'No se encontró el REP.' });
    await getAccessibleAgency(req.user, report.agencyId);
    req.repReport = report;
    return next();
  } catch (error) {
    return respondError(error, res, next);
  }
}

async function listRepReports(req, res, next) {
  try {
    const { agencyId, inspectionDate, calendarEventId } = req.query;
    if (!isValidDate(inspectionDate)) throw new RepRequestError(400, 'La fecha debe tener formato AAAA-MM-DD.');
    const agency = await getAccessibleAgency(req.user, agencyId);
    let eventFilter = {};
    if (calendarEventId) {
      if (!mongoose.isValidObjectId(calendarEventId)) {
        throw new RepRequestError(400, 'El identificador de la programación no es válido.');
      }
      const calendarEvent = await CalendarEvent.findOne({
        _id: calendarEventId,
        agencyId: agency._id,
        type: 'agency_visit',
        authorized: true,
      }).select('_id').lean();
      if (!calendarEvent) {
        throw new RepRequestError(404, 'No se encontró la programación de recorrido para esta agencia.');
      }
      eventFilter = { calendarEventId: calendarEvent._id };
    }
    const reports = await RepReport.find({
      agencyId: agency._id,
      status: { $ne: 'archived' },
      'generalData.inspectionDate': inspectionDate,
      ...eventFilter,
    })
      .select('reportId agencyNameSnapshot status revision generalData createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.json({ success: true, data: { reports } });
  } catch (error) {
    return respondError(error, res, next);
  }
}

async function createRepReport(req, res, next) {
  try {
    const { errors, value } = validateRepPayload(req.body);
    if (errors.length) throw new RepRequestError(400, 'Los datos del REP no son válidos.', errors);
    const agency = await getAccessibleAgency(req.user, req.body.agencyId);
    if (!req.body.calendarEventId) {
      throw new RepRequestError(400, 'El REP debe estar relacionado con una programación de recorrido.');
    }
    let calendarEvent = null;
    if (req.body.calendarEventId) {
      if (!mongoose.isValidObjectId(req.body.calendarEventId)) {
        throw new RepRequestError(400, 'El identificador de la programación no es válido.');
      }
      calendarEvent = await CalendarEvent.findOne({
        _id: req.body.calendarEventId,
        agencyId: agency._id,
        type: 'agency_visit',
        authorized: true,
      }).select('startAt endAt').lean();
      if (!calendarEvent) {
        throw new RepRequestError(404, 'No se encontró la programación de recorrido para esta agencia.');
      }
      const start = new Date(calendarEvent.startAt);
      const end = new Date(calendarEvent.endAt);
      const startParts = getLocalDateTime(start);
      const endParts = getLocalDateTime(end);
      value.generalData.inspectionDate = startParts.date;
      value.generalData.startDate = value.generalData.inspectionDate;
      value.generalData.endDate = endParts.date;
      value.generalData.startTime = startParts.time;
      value.generalData.endTime = endParts.time;
    }
    const idempotencyKey = value.idempotencyKey || crypto.randomUUID();
    const existing = await RepReport.findOne({ idempotencyKey });
    if (existing) {
      if (String(existing.agencyId) !== String(agency._id)) {
        throw new RepRequestError(409, 'La clave de idempotencia ya se utilizó para otra agencia.');
      }
      if (String(existing.createdBy) !== String(req.user._id)) {
        throw new RepRequestError(409, 'La clave de idempotencia ya se utilizó para otro usuario.');
      }
      await syncRepReportMonthlyFile(existing);
      return res.status(200).json({ success: true, data: { report: serializeRepReport(existing) } });
    }
    const reportForVisit = await RepReport.findOne({
      agencyId: agency._id,
      calendarEventId: calendarEvent._id,
      status: { $ne: 'archived' },
    });
    if (reportForVisit) {
      throw new RepRequestError(409, 'Ya existe un REP para este recorrido. Abre el reporte existente para continuar.');
    }
    const reportPeriod = value.generalData.inspectionDate.slice(0, 7);
    const monthlyFiles = await AgencyMonthlyFiles.findOne({
      agencyId: agency._id,
      period: reportPeriod,
    }).lean();
    const linkedFile = monthlyFiles?.archivos?.archivo3;
    if (linkedFile?.mode !== 'system' && (linkedFile?.driveId || linkedFile?.nombre)) {
      throw new RepRequestError(409, 'El período ya tiene un archivo REP vinculado desde Drive; no se puede crear otro en modo Sistema.');
    }
    if (linkedFile?.mode === 'system' && linkedFile.systemReportId) {
      const linkedReport = await RepReport.findOne({
        reportId: linkedFile.systemReportId,
        agencyId: agency._id,
      }).select('calendarEventId').lean();
      if (linkedReport?.calendarEventId
        && String(linkedReport.calendarEventId) !== String(calendarEvent._id)) {
        throw new RepRequestError(409, 'El archivo REP del período ya está vinculado a otro recorrido.');
      }
    }
    const report = await RepReport.create({
      reportId: `REP-${crypto.randomUUID()}`,
      idempotencyKey,
      agencyId: agency._id,
      calendarEventId: calendarEvent?._id || null,
      agencyNameSnapshot: agency.nombre,
      agencyLegalNameSnapshot: agency.razonSocial || '',
      agencyAddressSnapshot: agency.direccion || '',
      agencyStateSnapshot: agency.entidadFederativa || '',
      agencyBrandSnapshot: agency.marca || '',
      generalData: value.generalData,
      findings: value.findings,
      documents: value.documents,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await syncRepReportMonthlyFile(report);
    return res.status(201).json({ success: true, data: { report: serializeRepReport(report) } });
  } catch (error) {
    if (error?.code === 11000) {
      return respondError(
        new RepRequestError(409, 'Ya existe un REP vinculado a este recorrido. Abre el reporte existente para continuar.'),
        res,
        next,
      );
    }
    return respondError(error, res, next);
  }
}

async function getRepReport(req, res) {
  return res.json({ success: true, data: { report: serializeRepReport(req.repReport) } });
}

function getRepFindingImageResponse(image) {
  return {
    imageId: image.imageId,
    fileName: image.fileName,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    status: image.status,
    uploadedAt: image.uploadedAt,
  };
}

function receiveRepFindingImage(req, res, next) {
  const multer = require('multer');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  }).single('file');
  upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'La foto supera el límite de 10 MiB.' });
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ success: false, message: 'La carga debe incluir una sola imagen válida.' });
    }
    return next(error);
  });
}

async function uploadRepFindingImage(req, res, next) {
  try {
    const report = req.repReport;
    requireCanEdit(req.user, report);
    const { findingId, imageId } = req.params;
    if (!IMAGE_ID_PATTERN.test(findingId || '') || !IMAGE_ID_PATTERN.test(imageId || '')) {
      throw new RepRequestError(400, 'El registro o identificador de foto no es válido.');
    }
    if (!req.file?.buffer?.length) throw new RepRequestError(400, 'Selecciona una foto para cargar.');
    const finding = report.findings.find((entry) => entry.findingId === findingId);
    const image = finding?.images.find((entry) => entry.imageId === imageId);
    if (!image || image.imageId !== imageId || image.status === 'removed') {
      throw new RepRequestError(404, 'No se encontró la foto pendiente del hallazgo.');
    }
    if (image.status === 'active' && image.driveFileId) {
      return res.json({
        success: true,
        data: { image: getRepFindingImageResponse(image), reportRevision: report.revision },
      });
    }
    let processedImage;
    try {
      processedImage = await processForReportImage(req.file.buffer, req.file.mimetype);
    } catch (error) {
      if (error instanceof ImageProcessingError) throw new RepRequestError(422, error.message);
      throw error;
    }
    if (!ALLOWED_IMAGE_MIME_TYPES.has(req.file.mimetype) || req.file.mimetype !== image.mimeType) {
      throw new RepRequestError(415, 'Solo se admiten fotos JPEG, PNG o WebP.');
    }

    const drive = createGoogleDriveClient();
    const folderId = await ensureRepImageFolder(drive, report);
    const driveFile = await uploadRepImageToDrive(drive, {
      folderId,
      reportId: report.reportId,
      findingIndex: report.findings.indexOf(finding),
      imageId,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: processedImage.buffer,
    });
    const metadata = await getDriveFileMetadata(drive, driveFile.id);
    image.driveFileId = metadata.id;
    image.fileName = String(req.file.originalname || 'foto').replace(/[\\/:*?"<>|]/g, '_').slice(0, 255);
    image.mimeType = req.file.mimetype;
    image.sizeBytes = Number(metadata.size) || processedImage.buffer.length;
    image.checksum = metadata.md5Checksum || '';
    image.status = 'active';
    image.uploadedAt = new Date();
    report.revision += 1;
    report.generatedExcel.status = 'not_requested';
    report.generatedExcel.reportRevision = 0;
    report.generatedExcel.driveFileId = '';
    report.generatedExcel.downloadFileName = '';
    report.generatedExcel.error = '';
    report.updatedBy = req.user._id;
    await report.save();
    await syncRepReportMonthlyFile(report);
    return res.status(201).json({
      success: true,
      data: { image: getRepFindingImageResponse(image), reportRevision: report.revision },
    });
  } catch (error) {
    return respondError(error, res, next);
  }
}

async function streamRepFindingImage(req, res, next) {
  try {
    const { findingId, imageId } = req.params;
    if (!IMAGE_ID_PATTERN.test(findingId || '') || !IMAGE_ID_PATTERN.test(imageId || '')) {
      throw new RepRequestError(404, 'No se encontró la foto solicitada.');
    }
    const finding = req.repReport.findings.find((entry) => entry.findingId === findingId);
    const image = finding?.images.find((entry) => entry.imageId === imageId);
    if (!image || image.status !== 'active' || !image.driveFileId) {
      throw new RepRequestError(404, 'No se encontró la foto solicitada.');
    }
    const response = await createGoogleDriveClient().files.get(
      { fileId: image.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': image.mimeType,
      'Content-Length': String(image.sizeBytes),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    response.data.on('error', next);
    return response.data.pipe(res);
  } catch (error) {
    return respondError(error, res, next);
  }
}

async function updateRepReport(req, res, next) {
  try {
    const report = req.repReport;
    requireCanEdit(req.user, report);
    if (!Number.isInteger(req.body.expectedRevision) || req.body.expectedRevision !== report.revision) {
      throw new RepRequestError(409, 'El REP cambió antes de guardar. Recarga el reporte e inténtalo nuevamente.');
    }
    const { errors, value } = validateRepPayload(req.body);
    if (errors.length) throw new RepRequestError(400, 'Los datos del REP no son válidos.', errors);
    value.generalData = {
      ...value.generalData,
      inspectionDate: report.generalData.inspectionDate,
      startDate: report.generalData.startDate,
      endDate: report.generalData.endDate,
      startTime: report.generalData.startTime,
      endTime: report.generalData.endTime,
    };
    const before = JSON.stringify({
      generalData: report.generalData,
      findings: report.findings,
      documents: report.documents,
    });
    const after = JSON.stringify({
      generalData: value.generalData,
      findings: value.findings,
      documents: value.documents,
    });
    report.generalData = value.generalData;
    const previousFindings = report.findings;
    report.findings = value.findings.map((finding, index) => {
      const previousFinding = finding.findingId
        ? previousFindings.find((item) => item.findingId === finding.findingId)
        : previousFindings[index];
      const previousImages = previousFinding?.images || [];
      const nextImages = finding.images.map((image) => {
        const previousImage = previousImages.find((entry) => entry.imageId === image.imageId);
        if (previousImage?.status === 'active') return previousImage.toObject();
        if (image.status !== 'pending') {
          throw new RepRequestError(400, `La foto del hallazgo ${index + 1} no puede reutilizarse.`);
        }
        return image;
      });
      for (const previousImage of previousImages) {
        if (!nextImages.some((image) => image.imageId === previousImage.imageId)) {
          nextImages.push({ ...previousImage.toObject(), status: 'removed' });
        }
      }
      return { ...finding, images: nextImages };
    });
    report.documents = value.documents;
    if (req.body.status !== undefined) {
      if (!['draft', 'completed'].includes(req.body.status)) {
        throw new RepRequestError(400, 'El estado del REP debe ser draft o completed.');
      }
      report.status = req.body.status;
    }
    if (before !== after || req.body.status !== undefined) {
      report.revision += 1;
      report.generatedExcel = {
        status: 'not_requested',
        reportRevision: 0,
        templateVersion: TEMPLATE_VERSION,
        driveFileId: '',
        downloadFileName: '',
        queuedAt: null,
        startedAt: null,
        generatedAt: null,
        error: '',
      };
    }
    report.updatedBy = req.user._id;
    await report.save();
    await syncRepReportMonthlyFile(report);
    return res.json({ success: true, data: { report: serializeRepReport(report) } });
  } catch (error) {
    return respondError(error, res, next);
  }
}

function canGenerateReport(user, report) {
  const role = String(user?.rol || '').trim().toLowerCase();
  return ADMIN_ROLES.has(role) || (role === 'consultor' && String(report.createdBy) === String(user._id));
}

async function queueRepExcel(req, res, next) {
  try {
    const report = req.repReport;
    if (!canGenerateReport(req.user, report)) {
      throw new RepRequestError(403, 'Solo el consultor creador o un administrador puede generar el REP.');
    }
    if (!Number.isInteger(req.body.expectedRevision) || req.body.expectedRevision !== report.revision) {
      throw new RepRequestError(409, 'El REP cambió antes de solicitar el Excel. Guarda nuevamente para regenerarlo.');
    }
    const generated = report.generatedExcel || {};
    if (generated.status === 'ready'
      && generated.reportRevision === report.revision
      && generated.templateVersion === TEMPLATE_VERSION
      && generated.driveFileId) {
      try {
        const file = await getDriveFileMetadata(createGoogleDriveClient(), generated.driveFileId);
        if (!file.trashed) return res.json({ success: true, data: { generatedExcel: generated } });
      } catch (error) {
        if (error.code !== 404 && error.response?.status !== 404) throw error;
      }
    }
    if (generated.status === 'queued' || generated.status === 'processing') {
      return res.status(202).json({ success: true, data: { generatedExcel: generated } });
    }
    report.generatedExcel = {
      status: 'queued',
      reportRevision: report.revision,
      templateVersion: TEMPLATE_VERSION,
      driveFileId: '',
      downloadFileName: '',
      queuedAt: new Date(),
      startedAt: null,
      generatedAt: null,
      error: '',
    };
    await report.save();
    await syncRepReportMonthlyFile(report);
    kickRepExcelWorker();
    return res.status(202).json({ success: true, data: { generatedExcel: report.generatedExcel } });
  } catch (error) {
    return respondError(error, res, next);
  }
}

async function getRepExcelStatus(req, res, next) {
  try {
    if (!canGenerateReport(req.user, req.repReport)) {
      throw new RepRequestError(403, 'No tienes permiso para consultar la generación del REP.');
    }
    const stored = req.repReport.generatedExcel;
    const current = stored?.status === 'ready'
      && stored.reportRevision === req.repReport.revision
      && stored.templateVersion === TEMPLATE_VERSION;
    const generatedExcel = stored
      ? {
        status: stored.status === 'ready' && !current ? 'not_requested' : stored.status,
        reportRevision: stored.reportRevision,
        templateVersion: stored.templateVersion,
        downloadFileName: current ? stored.downloadFileName : '',
        queuedAt: stored.queuedAt,
        startedAt: stored.startedAt,
        generatedAt: stored.generatedAt,
        error: stored.error,
      }
      : null;
    return res.json({ success: true, data: { generatedExcel } });
  } catch (error) {
    return respondError(error, res, next);
  }
}

async function downloadRepExcel(req, res, next) {
  try {
    const report = req.repReport;
    if (!canGenerateReport(req.user, report)) {
      throw new RepRequestError(403, 'No tienes permiso para descargar el REP.');
    }
    const generated = report.generatedExcel;
    if (generated?.status !== 'ready'
      || generated.reportRevision !== report.revision
      || generated.templateVersion !== TEMPLATE_VERSION
      || !generated.driveFileId) {
      throw new RepRequestError(404, 'No hay un Excel validado para la revisión actual del REP.');
    }
    const response = await createGoogleDriveClient().files.get(
      { fileId: generated.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(generated.downloadFileName || 'REP-INS.xlsx')}"`,
    });
    response.data.on('error', (error) => res.destroy(error));
    return response.data.pipe(res);
  } catch (error) {
    return respondError(error, res, next);
  }
}

async function getRepLogo(req, res, next) {
  try {
    const agency = await getAccessibleAgency(req.user, req.query.agencyId);
    let brandName = agency.marca;
    if (req.query.reportId) {
      if (!REPORT_ID_PATTERN.test(req.query.reportId)) {
        throw new RepRequestError(400, 'El identificador del REP no es válido.');
      }
      const report = await RepReport.findOne({
        reportId: req.query.reportId,
        agencyId: agency._id,
      }).select('agencyBrandSnapshot').lean();
      if (!report) throw new RepRequestError(404, 'No se encontró el REP.');
      brandName = report.agencyBrandSnapshot || brandName;
    }
    const logo = await getBrandLogo(createGoogleDriveClient(), brandName);
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': logo.mimeType,
    });
    return res.send(logo.buffer);
  } catch (error) {
    return respondError(error, res, next);
  }
}

module.exports = {
  createRepReport,
  downloadRepExcel,
  getRepLogo,
  getRepExcelStatus,
  getRepReport,
  listRepReports,
  loadRepReport,
  queueRepExcel,
  receiveRepFindingImage,
  streamRepFindingImage,
  uploadRepFindingImage,
  updateRepReport,
};
