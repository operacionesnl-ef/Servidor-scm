'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const mongoose = require('mongoose');
const Agency = require('../../../models/Agency');
const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const ForReport = require('../models/ForReport');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
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
} = require('../../../services/googleDriveService');
const { ImageProcessingError, processForReportImage } = require('../services/forReportImageProcessor');
const {
  getGeneratedForReportExcelPath,
} = require('../services/forReportExcelFileStore');
const { kickForReportExcelWorker } = require('../services/forReportExcelWorker');
const { enqueueGeneration } = require('../../services/generationQueue');
const {
  buildDownloadFileName,
  TEMPLATE_VERSION,
} = require('../services/forReportExcelGenerator');

const ACCESS_ROLES = new Set(['admin', 'developer', 'consultor']);
const ADMIN_ROLES = new Set(['admin', 'developer']);
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
  if (!ACCESS_ROLES.has(role)) throw new RequestError(403, 'Tu cuenta no puede acceder a este formulario.');
  const filter = { _id: agencyId };
  if (role === 'consultor') filter.consultantId = user._id;
  const agency = await Agency.findOne(filter)
    .select('_id nombre razonSocial entidadFederativa marca fileNameCode')
    .lean();
  if (!agency) throw new RequestError(404, 'No se encontró la agencia o no tienes acceso asignado.');
  return agency;
}

function canEditSavedReports(user) {
  const role = String(user?.rol || '').trim().toLowerCase();
  return ADMIN_ROLES.has(role) || (role === 'consultor' && user?.canEditForReports === true);
}

function requireAdmin(req) {
  if (!canEditSavedReports(req.user)) throw new RequestError(403, 'Solo un administrador puede modificar reportes guardados o sus imágenes.');
}

function requireCanCreate(req) {
  const role = String(req.user?.rol || '').trim().toLowerCase();
  if (!ADMIN_ROLES.has(role) && role !== 'consultor') {
    throw new RequestError(403, 'Solo un administrador o consultor puede crear un reporte.');
  }
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

async function syncForReportMonthlyFile(report) {
  const period = report.agencyPeriod || report.generalData.inspectionDate.slice(0, 7);
  const generatedExcelIsCurrent = report.generatedExcel?.status === 'ready'
    && report.generatedExcel.reportRevision === report.revision
    && report.generatedExcel.templateVersion === TEMPLATE_VERSION;
  const file = {
    mode: 'system',
    systemReportId: report.reportId,
    nombre: report.generatedExcel?.downloadFileName || buildDownloadFileName(report),
    generatedExcelStatus: generatedExcelIsCurrent
      ? 'ready'
      : report.generatedExcel?.status === 'ready'
        ? 'not_requested'
        : report.generatedExcel?.status || 'not_requested',
    generatedExcelError: report.generatedExcel?.error || '',
    generatedExcelTemplateVersion: generatedExcelIsCurrent
      ? report.generatedExcel.templateVersion
      : '',
    driveId: generatedExcelIsCurrent ? report.generatedExcel.driveFileId || '' : '',
    ruta: generatedExcelIsCurrent ? report.drive?.generatedFolderId || '' : '',
    reportRevision: report.revision,
    generatedExcelRevision: generatedExcelIsCurrent ? report.revision : 0,
  };
  await AgencyMonthlyFiles.findOneAndUpdate(
    { agencyId: report.agencyId, period },
    {
      $set: {
        'archivos.archivo2': file,
        updatedBy: report.updatedBy || report.createdBy,
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

async function listForReports(req, res, next) {
  try {
    const { agencyId, inspectionDate, period } = req.query;
    if (period !== undefined && !/^(202\d|203\d|2040)-(0[1-9]|1[0-2])$/.test(period)) {
      throw new RequestError(400, 'El período debe tener formato AAAA-MM entre 2020 y 2040.');
    }
    if (!period && !isValidInspectionDate(inspectionDate)) {
      throw new RequestError(400, 'La fecha debe tener formato AAAA-MM-DD.');
    }
    const agency = await getAccessibleAgency(req.user, agencyId);
    const reportFilter = {
      agencyId: agency._id,
      status: { $ne: 'archived' },
      ...(period
        ? { agencyPeriod: period }
        : { 'generalData.inspectionDate': inspectionDate }),
    };
    const reports = await ForReport.find(reportFilter)
      .select('reportId agencyNameSnapshot status revision templateVersion generalData.visitNumber createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: { reports } });
  } catch (error) {
    respondWithError(error, res, next);
  }
}

async function getForReport(req, res) {
  const report = serializeReport(req.forReport);
  if (report.generatedExcel?.status === 'ready'
    && (report.generatedExcel.reportRevision !== report.revision
      || report.generatedExcel.templateVersion !== TEMPLATE_VERSION)) {
    report.generatedExcel = {
      ...report.generatedExcel,
      status: 'not_requested',
      localFileName: '',
      driveFileId: '',
      downloadFileName: '',
      error: '',
      templateOutdated: report.generatedExcel.templateVersion !== TEMPLATE_VERSION,
    };
  }
  res.json({ success: true, data: { report } });
}

function canRequestReportExcel(req) {
  const role = String(req.user?.rol || '').trim().toLowerCase();
  return ADMIN_ROLES.has(role)
    || (role === 'consultor' && String(req.forReport.createdBy) === String(req.user._id));
}

async function queueForReportExcel(req, res, next) {
  try {
    if (!canRequestReportExcel(req)) {
      throw new RequestError(403, 'Solo el creador consultor o un administrador puede generar el Excel.');
    }
    if (!Number.isInteger(req.body.expectedRevision) || req.body.expectedRevision !== req.forReport.revision) {
      throw new RequestError(409, 'El reporte cambió antes de solicitar el Excel. Guarda nuevamente para regenerarlo.');
    }
    const report = req.forReport;
    const generatedExcel = report.generatedExcel || {};
    if (generatedExcel.status === 'ready'
      && generatedExcel.reportRevision === report.revision
      && generatedExcel.templateVersion === TEMPLATE_VERSION) {
      if (generatedExcel.storageProvider === 'drive' && generatedExcel.driveFileId) {
        try {
          const driveFile = await getDriveFileMetadata(createGoogleDriveClient(), generatedExcel.driveFileId);
          if (!driveFile.trashed) {
            await syncForReportMonthlyFile(report);
            return res.json({ success: true, data: { generatedExcel } });
          }
        } catch (error) {
          if (error.code !== 404 && error.response?.status !== 404) throw error;
        }
      }
      if (generatedExcel.storageProvider === 'local' && generatedExcel.localFileName) {
        try {
          await getGeneratedForReportExcelPath(generatedExcel.localFileName);
          await syncForReportMonthlyFile(report);
          return res.json({ success: true, data: { generatedExcel } });
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof TypeError)) throw error;
        }
      }
    }
    if (generatedExcel.status === 'queued' || generatedExcel.status === 'processing') {
      return res.status(202).json({ success: true, data: { generatedExcel } });
    }
    report.generatedExcel = {
      status: 'queued',
      reportRevision: report.revision,
      templateVersion: TEMPLATE_VERSION,
      storageProvider: 'drive',
      localFileName: '',
      downloadFileName: '',
      driveFileId: '',
      queuedAt: new Date(),
      startedAt: null,
      generatedAt: null,
      error: '',
    };
    await report.save();
    await enqueueGeneration({
      type: 'FOR',
      entityId: report._id,
      reportId: report.reportId,
      revision: report.revision,
      userId: req.user._id,
    });
    await syncForReportMonthlyFile(report);
    kickForReportExcelWorker();
    return res.status(202).json({
      success: true,
      data: { generatedExcel: report.generatedExcel },
    });
  } catch (error) {
    return respondWithError(error, res, next);
  }
}

async function getForReportExcelStatus(req, res, next) {
  try {
    if (!canRequestReportExcel(req)) {
      throw new RequestError(403, 'No tienes permiso para consultar el estado del Excel.');
    }
    const stored = req.forReport.generatedExcel?.toObject
      ? req.forReport.generatedExcel.toObject()
      : req.forReport.generatedExcel;
    const templateOutdated = stored?.status === 'ready'
      && stored.templateVersion !== TEMPLATE_VERSION;
    const generatedExcel = stored
      ? {
        status: stored.status === 'ready'
          && (stored.reportRevision !== req.forReport.revision || templateOutdated)
          ? 'not_requested'
          : stored.status,
        reportRevision: stored.reportRevision,
        templateVersion: stored.templateVersion,
        templateOutdated,
        storageProvider: stored.storageProvider,
        downloadFileName: stored.status === 'ready' && !templateOutdated
          ? stored.downloadFileName
          : '',
        driveFileId: stored.status === 'ready' && !templateOutdated
          ? stored.driveFileId
          : '',
        queuedAt: stored.queuedAt,
        startedAt: stored.startedAt,
        generatedAt: stored.generatedAt,
        error: stored.error,
      }
      : null;
    return res.json({ success: true, data: { generatedExcel } });
  } catch (error) {
    return respondWithError(error, res, next);
  }
}

async function downloadForReportExcel(req, res, next) {
  try {
    if (!canRequestReportExcel(req)) {
      throw new RequestError(403, 'No tienes permiso para abrir el Excel generado.');
    }
    const generatedExcel = req.forReport.generatedExcel;
    if (generatedExcel?.status !== 'ready'
      || generatedExcel.reportRevision !== req.forReport.revision
      || generatedExcel.templateVersion !== TEMPLATE_VERSION) {
      throw new RequestError(404, 'No hay un Excel validado para la revisión actual del reporte.');
    }
    if (generatedExcel.storageProvider === 'drive' && generatedExcel.driveFileId) {
      const response = await createGoogleDriveClient().files.get(
        {
          fileId: generatedExcel.driveFileId,
          alt: 'media',
          supportsAllDrives: true,
        },
        { responseType: 'stream' },
      );
      const fileName = generatedExcel.downloadFileName || 'FOR-AUD-AMB.xlsx';
      res.set({
        'Cache-Control': 'no-store, private',
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'X-Content-Type-Options': 'nosniff',
      });
      response.data.on('error', next);
      return response.data.pipe(res);
    }
    if (generatedExcel.storageProvider !== 'local' || !generatedExcel.localFileName) {
      throw new RequestError(404, 'No hay un Excel validado para la revisión actual del reporte.');
    }
    const filePath = await getGeneratedForReportExcelPath(generatedExcel.localFileName);
    return res.download(
      filePath,
      generatedExcel.downloadFileName || generatedExcel.localFileName,
      (error) => {
      if (error && !res.headersSent) next(error);
      },
    );
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 404 || error.response?.status === 404) {
      return res.status(404).json({ success: false, message: 'El archivo Excel almacenado ya no está disponible.' });
    }
    return respondWithError(error, res, next);
  }
}

async function saveReportContent(req, res, next) {
  try {
    requireCanCreate(req);
    const { errors, value } = validateReportPayload(req.body);
    if (errors.length) throw new RequestError(422, 'El contenido del reporte no es válido.', errors);
    const idempotencyKey = req.get('Idempotency-Key');
    if (!IDENTIFIER_PATTERN.test(idempotencyKey || '')) {
      throw new RequestError(400, 'Falta una clave de idempotencia válida.');
    }
    const agency = await getAccessibleAgency(req.user, req.body.agencyId);
    value.generalData.companyName = agency.nombre;
    value.generalData.legalName = agency.razonSocial || '';
    let report = await ForReport.findOne({ idempotencyKey }).select('+idempotencyKey');
    if (report && String(report.createdBy) !== String(req.user._id)) {
      throw new RequestError(409, 'La clave de solicitud ya está asociada a otro reporte.');
    }
    if (report && (
      String(report.agencyId) !== String(agency._id)
      || report.generalData.inspectionDate !== value.generalData.inspectionDate
      || (report.agencyPeriod && report.agencyPeriod !== value.agencyPeriod)
    )) {
      throw new RequestError(409, 'La clave de solicitud ya se utilizó para otro reporte.');
    }
    const isNew = !report;
    if (report) report.agencyBrandSnapshot = agency.marca || '';
    if (!report) {
      const currentMonthlyRecord = await AgencyMonthlyFiles.findOne({
        agencyId: agency._id,
        period: value.agencyPeriod,
      }).select('archivos.archivo2').lean();
      const monthlyForFile = currentMonthlyRecord?.archivos?.archivo2;
      if (monthlyForFile?.driveId || (monthlyForFile?.nombre && monthlyForFile?.mode !== 'system')) {
        throw new RequestError(409, 'El período ya tiene un archivo FOR vinculado desde Drive; no se puede crear otro en modo Sistema.');
      }
      const reportForPeriod = await ForReport.findOne({
        agencyId: agency._id,
        agencyPeriod: value.agencyPeriod,
        status: { $ne: 'archived' },
      }).select('reportId').lean();
      if (reportForPeriod) {
        throw new RequestError(409, 'Ya existe un reporte del sistema para esta agencia y período. Debe actualizarse el reporte existente.');
      }
      const previousReport = await ForReport.findOne({
        agencyId: agency._id,
        'generalData.inspectionDate': value.generalData.inspectionDate,
        status: { $ne: 'archived' },
      }).sort({ 'generalData.visitNumber': -1, createdAt: -1 }).select('generalData.visitNumber').lean();
      value.generalData.visitNumber = Number.isInteger(previousReport?.generalData?.visitNumber)
        ? previousReport.generalData.visitNumber + 1
        : 1;
      report = new ForReport({
        reportId: `FOR-${crypto.randomUUID()}`,
        idempotencyKey,
        type: 'FOR',
        agencyId: agency._id,
        agencyNameSnapshot: agency.nombre,
        agencyStateSnapshot: agency.entidadFederativa || '',
        agencyBrandSnapshot: agency.marca || '',
        agencyFileNameCodeSnapshot: agency.fileNameCode || '',
        agencyPeriod: value.agencyPeriod,
        capturedBy: req.user._id,
        createdBy: req.user._id,
        updatedBy: req.user._id,
        generalData: {
          companyName: agency.nombre,
          legalName: agency.razonSocial || '',
          visitNumber: value.generalData.visitNumber,
          inspectionDate: value.generalData.inspectionDate,
          observations: '',
        },
        revision: 1,
        drive: {},
      });
    }
    const previousRevision = report.revision;
    const contentChanged = reconcileReportContent(report, value, req.user._id);
    if (!isNew && String(req.user.rol || '').toLowerCase() === 'consultor' && !canEditSavedReports(req.user)) {
      if (contentChanged) {
        throw new RequestError(403, 'Los consultores solo pueden crear reportes; no pueden modificarlos después de guardarlos.');
      }
      return res.json({
        success: true,
        data: { report: serializeReport(report) },
      });
    }
    if (report.revision !== previousRevision) {
      report.generatedExcel.status = 'not_requested';
      report.generatedExcel.localFileName = '';
      report.generatedExcel.downloadFileName = '';
      report.generatedExcel.downloadFileName = '';
      report.generatedExcel.driveFileId = '';
      report.generatedExcel.error = '';
    }
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
    await syncForReportMonthlyFile(report);
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
    requireAdmin(req);
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
    const agency = await getAccessibleAgency(req.user, report.agencyId);
    value.generalData.companyName = agency.nombre;
    value.generalData.legalName = agency.razonSocial || '';
    value.generalData.visitNumber = report.generalData.visitNumber || 1;
    const previousStatus = report.status;
    const previousRevision = report.revision;
    reconcileReportContent(report, value, req.user._id);
    report.status = requestedStatus;
    report.agencyBrandSnapshot = agency.marca || '';
    if (report.status !== previousStatus && report.revision === previousRevision) report.revision += 1;
    if (report.revision !== previousRevision) {
      report.generatedExcel.status = 'not_requested';
      report.generatedExcel.localFileName = '';
      report.generatedExcel.downloadFileName = '';
      report.generatedExcel.driveFileId = '';
      report.generatedExcel.error = '';
    }

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
    await syncForReportMonthlyFile(report);
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
    const role = String(req.user?.rol || '').trim().toLowerCase();
    const canUploadAsCreator = role === 'consultor'
      && req.forReport.status === 'draft'
      && String(req.forReport.createdBy) === String(req.user._id);
    if (!canUploadAsCreator) requireAdmin(req);
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
    report.generatedExcel.status = 'not_requested';
    report.generatedExcel.reportRevision = 0;
    report.generatedExcel.localFileName = '';
    report.generatedExcel.driveFileId = '';
    report.generatedExcel.error = '';
    report.updatedBy = req.user._id;
    await report.save();
    await syncForReportMonthlyFile(report);
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
    requireAdmin(req);
    const evidence = req.forReport.evidence.find((entry) => (
      entry.evidenceId === req.params.evidenceId && entry.status === 'active'
    ));
    const image = evidence?.images.find((entry) => entry.imageId === req.params.imageId);
    if (!image) throw new RequestError(404, 'No se encontró la imagen solicitada.');
    if (image.status !== 'removed') {
      image.status = 'removed';
      req.forReport.revision += 1;
      req.forReport.generatedExcel.status = 'not_requested';
      req.forReport.generatedExcel.reportRevision = 0;
      req.forReport.generatedExcel.localFileName = '';
      req.forReport.generatedExcel.downloadFileName = '';
      req.forReport.generatedExcel.driveFileId = '';
      req.forReport.generatedExcel.error = '';
      req.forReport.updatedBy = req.user._id;
      await req.forReport.save();
      await syncForReportMonthlyFile(req.forReport);
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
  downloadForReportExcel,
  getForReport,
  getForReportExcelStatus,
  listForReports,
  loadReport,
  queueForReportExcel,
  receiveEvidenceFile,
  removeReportImage,
  saveReportContent,
  streamReportImage,
  updateForReport,
  uploadReportImage,
};
