'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const ForReport = require('../models/ForReport');
const { createGoogleDriveClient } = require('../config/googleDrive');
const {
  ALLOWED_IMAGE_MIME_TYPES,
  IDENTIFIER_PATTERN,
  MAX_IMAGE_BYTES,
  getDetectedImageMimeType,
  isValidInspectionDate,
  reconcileReportContent,
  sanitizeOriginalName,
  serializeReport,
  validateReportCompletion,
  validateReportPayload,
} = require('../services/forReportService');
const {
  findDriveFileByAppProperties,
  findOrCreateFolder,
  getDriveFileMetadata,
  uploadDriveFile,
} = require('../services/googleDriveService');
const { ImageProcessingError, processForReportImage } = require('../services/forReportImageProcessor');

const WRITABLE_ROLES = new Set(['admin', 'developer', 'user', 'consultor']);
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

class RequestError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function respondWithError(error, res, next) {
  if (error instanceof RequestError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
      ...(error.details ? { errors: error.details } : {}),
    });
  }
  return next(error);
}

async function getAccessibleAgency(user, agencyId) {
  if (!mongoose.isValidObjectId(agencyId)) {
    throw new RequestError(400, 'El identificador de agencia no es válido.');
  }
  const role = String(user?.rol || '').toLowerCase();
  if (!WRITABLE_ROLES.has(role)) throw new RequestError(403, 'Tu cuenta no puede acceder a este formulario.');
  const filter = { _id: agencyId };
  if (role === 'consultor') filter.consultantId = user._id;
  const agency = await Agency.findOne(filter).select('_id nombre').lean();
  if (!agency) throw new RequestError(404, 'No se encontró la agencia o no tienes acceso asignado.');
  return agency;
}

async function loadReport(req, res, next, reportId) {
  try {
    if (typeof reportId !== 'string' || !/^FOR-[a-f\d-]{36}$/i.test(reportId)) {
      return res.status(404).json({ success: false, message: 'No se encontró el reporte.' });
    }
    const report = await ForReport.findOne({ reportId });
    if (!report) return res.status(404).json({ success: false, message: 'No se encontró el reporte.' });
    await getAccessibleAgency(req.user, report.agencyId);
    req.forReport = report;
    return next();
  } catch (error) {
    return respondWithError(error, res, next);
  }
}

function makeEvidenceFolderName(value) {
  const cleaned = String(value || 'Agencia')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || 'Agencia';
}

async function ensureEvidenceFolder(drive, report) {
  if (report.drive.evidenceFolderId) return report.drive.evidenceFolderId;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) throw new Error('No está configurado el ID de la carpeta raíz de Google Drive.');

  const year = report.generalData.inspectionDate.slice(0, 4);
  const month = report.generalData.inspectionDate.slice(5, 7);
  const folderNames = [
    'Evidencias',
    year,
    month,
    makeEvidenceFolderName(report.agencyNameSnapshot),
    'FOR',
    report.reportId,
  ];
  let parentId = rootFolderId;
  for (const folderName of folderNames) {
    const folder = await findOrCreateFolder(drive, parentId, folderName);
    parentId = folder.id;
  }
  report.drive.evidenceFolderId = parentId;
  await report.save();
  return parentId;
}

function getImageResponse(image) {
  return {
    imageId: image.imageId,
    fileName: image.fileName,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    status: image.status,
    uploadedAt: image.uploadedAt,
  };
}

async function listForReports(req, res, next) {
  try {
    const { agencyId, inspectionDate } = req.query;
    if (!isValidInspectionDate(inspectionDate)) {
      throw new RequestError(400, 'La fecha debe tener formato AAAA-MM-DD.');
    }
    const agency = await getAccessibleAgency(req.user, agencyId);
    const reports = await ForReport.find({
      agencyId: agency._id,
      'generalData.inspectionDate': inspectionDate,
      status: { $ne: 'archived' },
    })
      .select('reportId agencyNameSnapshot status revision templateVersion createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: { reports } });
  } catch (error) {
    respondWithError(error, res, next);
  }
}

async function getForReport(req, res) {
  res.json({ success: true, data: { report: serializeReport(req.forReport) } });
}

async function saveReportContent(req, res, next) {
  try {
    const { errors, value } = validateReportPayload(req.body);
    if (errors.length) throw new RequestError(422, 'El contenido del reporte no es válido.', errors);
    const idempotencyKey = req.get('Idempotency-Key');
    if (!IDENTIFIER_PATTERN.test(idempotencyKey || '')) {
      throw new RequestError(400, 'Falta una clave de idempotencia válida.');
    }
    const agency = await getAccessibleAgency(req.user, req.body.agencyId);
    let report = await ForReport.findOne({ idempotencyKey }).select('+idempotencyKey');
    if (report && String(report.createdBy) !== String(req.user._id)) {
      throw new RequestError(409, 'La clave de solicitud ya está asociada a otro reporte.');
    }
    if (report && (
      String(report.agencyId) !== String(agency._id)
      || report.generalData.inspectionDate !== value.generalData.inspectionDate
    )) {
      throw new RequestError(409, 'La clave de solicitud ya se utilizó para otro reporte.');
    }
    const isNew = !report;
    if (!report) {
      report = new ForReport({
        reportId: `FOR-${crypto.randomUUID()}`,
        idempotencyKey,
        type: 'FOR',
        agencyId: agency._id,
        agencyNameSnapshot: agency.nombre,
        capturedBy: req.user._id,
        createdBy: req.user._id,
        updatedBy: req.user._id,
        generalData: {
          companyName: agency.nombre,
          inspectionDate: value.generalData.inspectionDate,
          observations: '',
        },
        revision: 1,
        drive: {},
      });
    }
    reconcileReportContent(report, value, req.user._id);
    if (isNew) report.revision = 1;
    try {
      await report.save();
    } catch (error) {
      if (error.code !== 11000 || !isNew) throw error;
      report = await ForReport.findOne({ idempotencyKey }).select('+idempotencyKey');
      if (!report || String(report.createdBy) !== String(req.user._id)) {
        throw new RequestError(409, 'No se pudo completar la solicitud idempotente. Reintenta guardar.');
      }
      reconcileReportContent(report, value, req.user._id);
      await report.save();
    }
    return res.status(isNew ? 201 : 200).json({
      success: true,
      data: { report: serializeReport(report) },
    });
  } catch (error) {
    return respondWithError(error, res, next);
  }
}

async function updateForReport(req, res, next) {
  try {
    const { errors, value } = validateReportPayload(req.body);
    if (errors.length) throw new RequestError(422, 'El contenido del reporte no es válido.', errors);
    if (!Number.isInteger(req.body.expectedRevision) || req.body.expectedRevision !== req.forReport.revision) {
      throw new RequestError(409, 'El reporte cambió desde que lo abriste. Recárgalo antes de guardar.');
    }
    const requestedStatus = req.body.status || 'draft';
    if (!['draft', 'completed'].includes(requestedStatus)) {
      throw new RequestError(400, 'El estado del reporte no es válido.');
    }
    const report = req.forReport;
    const previousStatus = report.status;
    const previousRevision = report.revision;
    reconcileReportContent(report, value, req.user._id);
    report.status = requestedStatus;
    if (report.status !== previousStatus && report.revision === previousRevision) report.revision += 1;

    if (requestedStatus === 'completed') {
      const completion = validateReportCompletion(report);
      if (!completion.complete) {
        throw new RequestError(422, 'El reporte todavía tiene requisitos pendientes.', {
          missingAspects: completion.missingAspects,
          missingEvidence: completion.missingEvidence,
          pendingImages: completion.pendingImages,
        });
      }
    }

    await report.save();
    res.json({ success: true, data: { report: serializeReport(report) } });
  } catch (error) {
    if (error.name === 'VersionError') {
      return res.status(409).json({
        success: false,
        message: 'El reporte cambió desde que lo abriste. Recárgalo antes de guardar.',
      });
    }
    respondWithError(error, res, next);
  }
}

function receiveEvidenceFile(req, res, next) {
  const multer = require('multer');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  }).single('file');
  upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'La imagen supera el límite de 10 MiB.' });
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ success: false, message: 'La carga debe incluir una sola imagen válida.' });
    }
    return next(error);
  });
}

async function uploadReportImage(req, res, next) {
  try {
    const { evidenceId, imageId } = req.params;
    if (!IDENTIFIER_PATTERN.test(evidenceId) || !IDENTIFIER_PATTERN.test(imageId)) {
      throw new RequestError(400, 'El identificador de evidencia o imagen no es válido.');
    }
    if (!req.file?.buffer?.length) throw new RequestError(400, 'Selecciona una imagen para cargar.');
    const mimeType = getDetectedImageMimeType(req.file.buffer);
    if (!mimeType || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new RequestError(415, 'Solo se admiten imágenes JPEG, PNG o WebP.');
    }

    const report = req.forReport;
    const evidence = report.evidence.find((entry) => entry.evidenceId === evidenceId && entry.status === 'active');
    const image = evidence?.images.find((entry) => entry.imageId === imageId);
    if (!image || image.status === 'removed') throw new RequestError(404, 'No se encontró la imagen pendiente.');
    if (image.mimeType && image.mimeType !== mimeType) {
      throw new RequestError(415, 'El contenido de la imagen no coincide con su tipo declarado.');
    }
    if (image.status === 'active') {
      return res.json({
        success: true,
        data: { image: getImageResponse(image), reportRevision: report.revision },
      });
    }

    let processedImage;
    try {
      processedImage = await processForReportImage(req.file.buffer, mimeType);
    } catch (error) {
      if (error instanceof ImageProcessingError) {
        throw new RequestError(422, error.message);
      }
      throw error;
    }

    const drive = createGoogleDriveClient();
    const folderId = await ensureEvidenceFolder(drive, report);
    const appProperties = {
      efcoreReportId: report.reportId,
      efcoreEvidenceId: evidenceId,
      efcoreImageId: imageId,
    };
    const existingFile = await findDriveFileByAppProperties(drive, folderId, appProperties);
    const extension = IMAGE_EXTENSIONS[mimeType];
    const driveName = `${imageId}.${extension}`;
    const driveFile = existingFile || await uploadDriveFile(drive, {
      folderId,
      fileName: driveName,
      mimeType,
      body: Readable.from([processedImage.buffer]),
      appProperties,
    });
    if (driveFile.name !== driveName || !driveFile.parents?.includes(folderId)) {
      throw new Error('El archivo encontrado en Drive no coincide con la ruta esperada.');
    }

    const metadata = existingFile ? existingFile : await getDriveFileMetadata(drive, driveFile.id);
    image.driveFileId = metadata.id;
    image.fileName = sanitizeOriginalName(req.file.originalname);
    image.mimeType = mimeType;
    image.sizeBytes = Number(metadata.size) || processedImage.buffer.length;
    image.checksum = metadata.md5Checksum || '';
    image.status = 'active';
    image.uploadedAt = new Date();
    report.revision += 1;
    report.updatedBy = req.user._id;
    await report.save();
    return res.status(201).json({
      success: true,
      data: { image: getImageResponse(image), reportRevision: report.revision },
    });
  } catch (error) {
    return respondWithError(error, res, next);
  }
}

async function streamReportImage(req, res, next) {
  try {
    const { evidenceId, imageId } = req.params;
    const evidence = req.forReport.evidence.find((entry) => entry.evidenceId === evidenceId && entry.status === 'active');
    const image = evidence?.images.find((entry) => entry.imageId === imageId && entry.status === 'active');
    if (!image?.driveFileId) throw new RequestError(404, 'No se encontró la imagen solicitada.');

    const drive = createGoogleDriveClient();
    const response = await drive.files.get(
      { fileId: image.driveFileId, alt: 'media' },
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
    response.data.pipe(res);
  } catch (error) {
    respondWithError(error, res, next);
  }
}

async function removeReportImage(req, res, next) {
  try {
    const evidence = req.forReport.evidence.find((entry) => (
      entry.evidenceId === req.params.evidenceId && entry.status === 'active'
    ));
    const image = evidence?.images.find((entry) => entry.imageId === req.params.imageId);
    if (!image) throw new RequestError(404, 'No se encontró la imagen solicitada.');
    if (image.status !== 'removed') {
      image.status = 'removed';
      req.forReport.revision += 1;
      req.forReport.updatedBy = req.user._id;
      await req.forReport.save();
    }
    res.json({
      success: true,
      data: { image: getImageResponse(image), reportRevision: req.forReport.revision },
    });
  } catch (error) {
    respondWithError(error, res, next);
  }
}

module.exports = {
  getForReport,
  listForReports,
  loadReport,
  receiveEvidenceFile,
  removeReportImage,
  saveReportContent,
  streamReportImage,
  updateForReport,
  uploadReportImage,
};
