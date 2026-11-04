'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Agency = require('../../../models/Agency');
const CalendarEvent = require('../../../models/CalendarEvent');
const RepReport = require('../models/RepReport');
const ANX = require('../models/ANX');
const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const { deleteDriveFile, getDriveFileMetadata } = require('../../../services/googleDriveService');
const { processForReportImage, ImageProcessingError } = require('../../for/services/forReportImageProcessor');
const {
  ensureRepImageFolder,
  getBrandLogo,
  uploadRepImageToDrive,
} = require('../services/repDriveStorage');
const { syncRepReportMonthlyFile } = require('../services/repMonthlyFileSync');
const { kickRepExcelWorker } = require('../services/repExcelWorker');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const {
  RepExcelError,
  TEMPLATE_VERSION,
} = require('../services/repExcelGenerator');
const { serializeRepReport, validateRepPayload, isValidDate } = require('../services/repService');
const {
  AnxPowerPointError,
  buildAnxFileName,
  generateAnxPowerPointBuffer,
} = require('../../anx/services/anxPowerPointGenerator');

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
    .select('_id nombre razonSocial direccion entidadFederativa brand marca fileNameCode consultantId')
    .lean();
  if (!agency) throw new RepRequestError(404, 'No se encontró la agencia o no tienes acceso asignado.');
  return agency;
}

function getAgencyBrand(agency) {
  return String(agency?.brand || agency?.marca || '').trim();
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
    logConsoleEvent('rep_create_started', {
      agencyId: req.body?.agencyId || '',
      userId: String(req.user?._id || ''),
      findingCount: Array.isArray(req.body?.findings) ? req.body.findings.length : 0,
    });
    const { errors, value } = validateRepPayload(req.body);
    if (errors.length) {
      throw new RepRequestError(400, `Los datos del REP no son válidos: ${errors.join(' ')}`, errors);
    }
    value.findings.forEach((finding) => {
      if (!finding.findingId) finding.findingId = crypto.randomUUID();
    });
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
      const responseReport = await attachRepAnxImages(serializeRepReport(existing));
      logConsoleEvent('rep_create_idempotent', { reportId: existing.reportId, revision: existing.revision });
      return res.status(200).json({ success: true, data: { report: responseReport } });
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
      agencyBrandSnapshot: getAgencyBrand(agency),
      agencyFileNameCodeSnapshot: agency.fileNameCode || '',
      generalData: value.generalData,
      findings: value.findings.map(({ images, ...finding }) => finding),
      documents: value.documents,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await syncRepReportMonthlyFile(report);
    const responseReport = await attachRepAnxImages(serializeRepReport(report));
    logConsoleEvent('rep_create_completed', {
      reportId: report.reportId,
      revision: report.revision,
      findingCount: report.findings.length,
    });
    return res.status(201).json({ success: true, data: { report: responseReport } });
  } catch (error) {
    logConsoleEvent('rep_create_failed', {
      agencyId: req.body?.agencyId || '',
      userId: String(req.user?._id || ''),
      status: error.status || 500,
      message: error.message,
    });
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

async function attachRepAnxImages(report) {
  const anx = await ANX.findOne({ reporteId: report.reportId }).lean();
  const images = Array.isArray(anx?.imagenes) ? anx.imagenes : [];
  report.findings = (report.findings || []).map((finding) => {
    const image = images.find((entry) => entry.registroId === finding.findingId);
    return {
      ...finding,
      imageNumber: image?.numero || '',
      images: image ? [{
        imageId: image.imageId,
        fileName: image.fileName,
        mimeType: image.mimeType,
        status: 'active',
      }] : [],
    };
  });
  return report;
}

async function getRepReport(req, res, next) {
  try {
    const report = await attachRepAnxImages(serializeRepReport(req.repReport));
  return res.json({ success: true, data: { report } });
  } catch (error) {
    return respondError(error, res, next);
  }
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
    if (!error) {
      logConsoleEvent('rep_image_received', {
        reportId: req.params.reportId,
        findingId: req.params.findingId,
        imageId: req.params.imageId,
        fileName: req.file?.originalname || '',
        mimeType: req.file?.mimetype || '',
        bytes: req.file?.size || 0,
      });
      return next();
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      logConsoleEvent('rep_image_rejected', {
        reportId: req.params.reportId,
        findingId: req.params.findingId,
        imageId: req.params.imageId,
        reason: 'file_too_large',
      });
      return res.status(413).json({ success: false, message: 'La foto supera el límite de 10 MiB.' });
    }
    if (error instanceof multer.MulterError) {
      logConsoleEvent('rep_image_rejected', {
        reportId: req.params.reportId,
        findingId: req.params.findingId,
        imageId: req.params.imageId,
        reason: error.code,
      });
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
    const findingIndex = report.findings.findIndex((entry) => entry.findingId === findingId);
    const finding = report.findings[findingIndex];
    if (!finding) throw new RepRequestError(404, 'No se encontró el registro del REP.');
    const anx = await ANX.findOne({ reporteId: report.reportId });
    const currentImage = anx?.imagenes?.find((entry) => entry.registroId === findingId);
    if (currentImage) {
      if (currentImage.imageId === imageId) {
        logConsoleEvent('rep_image_upload_idempotent', { reportId: report.reportId, findingId, imageId });
        return res.status(200).json({
          success: true,
          data: {
            image: {
              imageId: currentImage.imageId,
              fileName: currentImage.fileName,
              mimeType: currentImage.mimeType,
              status: 'active',
            },
            reportRevision: report.revision,
          },
        });
      }
      return res.status(409).json({
        success: false,
        message: 'Este registro ya tiene una fotografía asociada.',
      });
    }
    if (anx?.imagenes.length >= 40) throw new RepRequestError(409, 'El anexo admite hasta 40 fotografías.');
    if (!ALLOWED_IMAGE_MIME_TYPES.has(req.file.mimetype)) {
      throw new RepRequestError(415, 'Solo se admiten fotos JPEG, PNG o WebP.');
    }
    let processedImage;
    try {
      processedImage = await processForReportImage(req.file.buffer, req.file.mimetype);
    } catch (error) {
      if (error instanceof ImageProcessingError) throw new RepRequestError(422, error.message);
      throw error;
    }

    const drive = createGoogleDriveClient();
    const folderId = await ensureRepImageFolder(drive, report);
    logConsoleEvent('rep_image_drive_upload_started', {
      reportId: report.reportId,
      findingId,
      imageId,
      bytes: processedImage.buffer.length,
      resized: processedImage.resized,
    });
    const driveFile = await uploadRepImageToDrive(drive, {
      folderId,
      reportId: report.reportId,
      findingIndex,
      imageId,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: processedImage.buffer,
    });
    const metadata = await getDriveFileMetadata(drive, driveFile.id);
    if (!metadata?.id || metadata.trashed) {
      throw new RepRequestError(502, 'Google Drive no confirmó el archivo de la foto.');
    }
    const imageEntry = {
      imageId,
      numero: findingIndex + 1,
      registroId: findingId,
      nombre: `Imagen ${findingIndex + 1}`,
      driveFileId: metadata.id,
      fileName: String(req.file.originalname || 'foto').replace(/[\\/:*?"<>|]/g, '_').slice(0, 255),
      mimeType: req.file.mimetype,
      tamanoBytes: Number(metadata.size) || processedImage.buffer.length,
      checksum: metadata.md5Checksum || '',
      fechaSubida: new Date(),
      subidoPor: req.user._id,
    };
    const anxDocument = anx || new ANX({ reporteId: report.reportId });
    anxDocument.imagenes.push(imageEntry);
    anxDocument.totalImagenes = anxDocument.imagenes.length;
    await anxDocument.save();
    logConsoleEvent('rep_image_anx_saved', {
      reportId: report.reportId,
      findingId,
      imageId,
      totalImages: anxDocument.totalImagenes,
    });
    finding.imageNumber = findingIndex + 1;
    report.revision += 1;
    report.generatedExcel.status = 'not_requested';
    report.generatedExcel.reportRevision = 0;
    report.generatedExcel.driveFileId = '';
    report.generatedExcel.downloadFileName = '';
    report.generatedExcel.error = '';
    report.updatedBy = req.user._id;
    await report.save();
    await syncRepReportMonthlyFile(report);
    logConsoleEvent('rep_image_upload_completed', {
      reportId: report.reportId,
      findingId,
      imageId,
      reportRevision: report.revision,
      driveFileId: metadata.id,
    });
    return res.status(201).json({
      success: true,
      data: { image: { imageId, fileName: imageEntry.fileName, mimeType: imageEntry.mimeType, status: 'active' }, reportRevision: report.revision },
    });
  } catch (error) {
    logConsoleEvent('rep_image_upload_failed', {
      reportId: req.repReport?.reportId || req.params.reportId,
      findingId: req.params.findingId,
      imageId: req.params.imageId,
      status: error.status || 500,
      message: error.message,
    });
    return respondError(error, res, next);
  }
}

async function streamRepFindingImage(req, res, next) {
  try {
    const { findingId, imageId } = req.params;
    if (!IMAGE_ID_PATTERN.test(findingId || '') || !IMAGE_ID_PATTERN.test(imageId || '')) {
      throw new RepRequestError(404, 'No se encontró la foto solicitada.');
    }
    const anx = await ANX.findOne({ reporteId: req.repReport.reportId });
    const image = anx?.imagenes?.find((entry) => entry.registroId === findingId && entry.imageId === imageId);
    if (!image || !image.driveFileId) {
      throw new RepRequestError(404, 'No se encontró la foto solicitada.');
    }
    const response = await createGoogleDriveClient().files.get(
      { fileId: image.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': image.mimeType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    const imageSize = Number(image.tamanoBytes);
    if (Number.isFinite(imageSize) && imageSize > 0) res.set('Content-Length', String(imageSize));
    response.data.on('error', next);
    return response.data.pipe(res);
  } catch (error) {
    logConsoleEvent('rep_image_stream_failed', {
      reportId: req.repReport?.reportId || req.params.reportId,
      findingId: req.params.findingId,
      imageId: req.params.imageId,
      status: error.status || 500,
      message: error.message,
    });
    return respondError(error, res, next);
  }
}

async function updateRepReport(req, res, next) {
  try {
    const report = req.repReport;
    logConsoleEvent('rep_update_started', {
      reportId: report.reportId,
      revision: report.revision,
      expectedRevision: req.body.expectedRevision,
      findingCount: Array.isArray(req.body.findings) ? req.body.findings.length : 0,
    });
    requireCanEdit(req.user, report);
    if (!Number.isInteger(req.body.expectedRevision) || req.body.expectedRevision !== report.revision) {
      throw new RepRequestError(409, 'El REP cambió antes de guardar. Recarga el reporte e inténtalo nuevamente.');
    }
    const { errors, value } = validateRepPayload(req.body);
    if (errors.length) {
      throw new RepRequestError(400, `Los datos del REP no son válidos: ${errors.join(' ')}`, errors);
    }
    value.findings.forEach((finding, index) => {
      if (!finding.findingId) {
        finding.findingId = report.findings[index]?.findingId || crypto.randomUUID();
      }
    });
    value.generalData = {
      ...value.generalData,
      inspectionDate: report.generalData.inspectionDate,
      startDate: report.generalData.startDate,
      endDate: report.generalData.endDate,
      startTime: report.generalData.startTime,
      endTime: report.generalData.endTime,
    };
    const anx = await ANX.findOne({ reporteId: report.reportId });
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
    const incomingFindings = Array.isArray(req.body.findings) ? req.body.findings : [];
    value.findings = value.findings.map((finding) => {
      const incoming = incomingFindings.find((entry) => entry?.findingId === finding.findingId);
      if (incoming && incoming.images === undefined) {
        const existingImage = anx?.imagenes?.find((image) => image.registroId === finding.findingId);
        if (existingImage) {
          return {
            ...finding,
            images: [{
              imageId: existingImage.imageId,
              fileName: existingImage.fileName,
              mimeType: existingImage.mimeType,
              status: 'active',
            }],
          };
        }
      }
      return finding;
    });
    report.findings = value.findings.map(({ images, ...finding }) => finding);
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
    if (anx) {
      const desiredImageIds = new Set(value.findings.flatMap((finding) => (
        finding.images.map((image) => `${finding.findingId}:${image.imageId}`)
      )));
      const removedImages = anx.imagenes.filter((image) => !desiredImageIds.has(`${image.registroId}:${image.imageId}`));
      if (removedImages.length) {
        anx.imagenes = anx.imagenes.filter((image) => desiredImageIds.has(`${image.registroId}:${image.imageId}`));
        anx.totalImagenes = anx.imagenes.length;
        if (!anx.totalImagenes) await ANX.deleteOne({ _id: anx._id });
        else await anx.save();
        const deletionResults = await Promise.allSettled(removedImages.map((image) => (
          deleteDriveFile(createGoogleDriveClient(), image.driveFileId)
        )));
        deletionResults.forEach((result, index) => {
          if (result.status === 'rejected') {
            logConsoleEvent('rep_image_drive_delete_failed', {
              reportId: report.reportId,
              driveFileId: removedImages[index].driveFileId,
              message: result.reason?.message || 'No se pudo eliminar la imagen de Google Drive.',
            });
          }
        });
      }
    }
    await syncRepReportMonthlyFile(report);
    const responseReport = await attachRepAnxImages(serializeRepReport(report));
    logConsoleEvent('rep_update_completed', {
      reportId: report.reportId,
      revision: report.revision,
      findingCount: report.findings.length,
    });
    return res.json({ success: true, data: { report: responseReport } });
  } catch (error) {
    logConsoleEvent('rep_update_failed', {
      reportId: req.repReport?.reportId || req.params.reportId,
      status: error.status || 500,
      message: error.message,
    });
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

async function generateRepAnx(req, res, next) {
  try {
    const report = req.repReport;
    if (!canGenerateReport(req.user, report)) {
      throw new RepRequestError(403, 'No tienes permiso para generar el anexo fotográfico.');
    }
    const anx = await ANX.findOne({ reporteId: report.reportId }).lean();
    if (!anx || anx.estado === 'cancelado' || !anx.totalImagenes) {
      throw new RepRequestError(404, 'El reporte no tiene fotografías asociadas en ANX.');
    }
    if (anx.totalImagenes !== anx.imagenes.length) {
      throw new RepRequestError(409, 'El total de imágenes de ANX no coincide con sus registros.');
    }
    const drive = createGoogleDriveClient();
    const images = await Promise.all(anx.imagenes.map(async (image) => {
      const response = await drive.files.get(
        { fileId: image.driveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' },
      );
      const chunks = [];
      for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
      return { numero: image.numero, mimeType: image.mimeType, buffer: Buffer.concat(chunks) };
    }));
    const logo = await getBrandLogo(drive, report.agencyBrandSnapshot);
    const buffer = await generateAnxPowerPointBuffer(images, {
      logoBuffer: logo.buffer,
      logoMimeType: logo.mimeType,
    });
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(buildAnxFileName(report))}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(buffer);
  } catch (error) {
    if (error instanceof AnxPowerPointError) {
      return res.status(422).json({ success: false, message: error.message });
    }
    return respondError(error, res, next);
  }
}

async function getRepLogo(req, res, next) {
  try {
    const agency = await getAccessibleAgency(req.user, req.query.agencyId);
    let brandName = getAgencyBrand(agency);
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
    console.info('[REP API] Resolviendo logotipo de agencia', {
      agencyId: String(agency._id),
      reportId: req.query.reportId || null,
      brandField: agency.brand || '',
      marcaField: agency.marca || '',
      selectedBrand: brandName || '',
    });
    const logo = await getBrandLogo(createGoogleDriveClient(), brandName);
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': logo.mimeType,
    });
    logConsoleEvent('rep_logo_loaded', {
      agencyId: String(agency._id),
      reportId: req.query.reportId || '',
      brand: brandName || '',
      mimeType: logo.mimeType,
      bytes: logo.buffer.length,
    });
    return res.send(logo.buffer);
  } catch (error) {
    console.error('[REP API] Error al resolver logotipo', {
      agencyId: req.query.agencyId || '',
      reportId: req.query.reportId || null,
      status: error.status || 500,
      message: error.message,
    });
    logConsoleEvent('rep_logo_load_failed', {
      agencyId: req.query.agencyId || '',
      reportId: req.query.reportId || '',
      status: error.status || 500,
      message: error.message,
    });
    return respondError(error, res, next);
  }
}

module.exports = {
  createRepReport,
  downloadRepExcel,
  generateRepAnx,
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
