'use strict';

const ANX = require('../models/ANX');
const RepReport = require('../models/RepReport');
const Agency = require('../../../models/Agency');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const {
  getGoogleDriveErrorStatus,
  retryTransientGoogleDriveOperation,
} = require('../../../services/googleDriveService');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const { getReviewIntervalMonths } = require('../../../utils/reviewPeriod');
const { shouldPauseComplexJobs } = require('../../../services/resourceMonitor');
const {
  enqueueGeneration,
  kickGenerationQueue,
  registerGenerationProcessor,
} = require('../../services/generationQueue');
const {
  AnxPowerPointError,
  buildAnxFileName,
  generateAnxPowerPointBuffer,
} = require('../../anx/services/anxPowerPointGenerator');
const { syncRepReportMonthlyFile } = require('./repMonthlyFileSync');
const {
  RepDriveStorageError,
  ensureRepFolder,
  getBrandLogo,
  uploadRepAnxToDrive,
} = require('./repDriveStorage');

const POLL_INTERVAL_MS = 1500;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const DRIVE_IMAGE_TIMEOUT_MS = 120_000;
let workerPromise = null;
let pollTimer = null;

async function downloadAnxImage(drive, image) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DRIVE_IMAGE_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await drive.files.get(
      { fileId: image.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream', signal: controller.signal },
    );
    const chunks = [];
    for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
    return {
      numero: image.numero,
      findingId: image.registroId,
      mimeType: image.mimeType,
      buffer: Buffer.concat(chunks),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function setGenerationFailure(anx, report, revision, error, generationStage) {
  const message = error instanceof AnxPowerPointError || error instanceof RepDriveStorageError
    ? error.message
    : 'Error interno al generar ANX. Revisa los registros del servidor.';
  const result = await ANX.updateOne(
    {
      _id: anx._id,
      'archivoGenerado.revision': revision,
      'archivoGenerado.estado': 'processing',
    },
    {
      $set: {
        'archivoGenerado.estado': 'failed',
        'archivoGenerado.driveFileId': '',
        'archivoGenerado.nombre': '',
        'archivoGenerado.startedAt': null,
        'archivoGenerado.error': message.slice(0, 1000),
      },
    },
  );
  if (result.modifiedCount === 1 && report) await syncRepReportMonthlyFile(report, { syncExcel: false });
  const errorMessage = error instanceof Error ? error.message : String(error);
  const causeMessage = error instanceof Error && error.cause instanceof Error
    ? `; causa: ${error.cause.message}`
    : '';
  logConsoleEvent('rep_anx_failed', {
    reportId: anx.reporteId,
    reportRevision: revision,
    message: `${message} [etapa: ${generationStage}; ${error instanceof Error ? error.name : 'Error'}: ${errorMessage}${causeMessage}]`,
    persisted: result.modifiedCount === 1,
  });
}

async function processClaimedAnx(anx) {
  const revision = anx.archivoGenerado.revision;

  let report = null;
  let generationStage = 'cargar REP';
  try {
    report = await RepReport.findOne({ reportId: anx.reporteId });
    if (!report || report.revision !== revision) {
      throw new AnxPowerPointError('El REP cambió durante la generación; vuelve a validar el reporte.');
    }
    const agency = await Agency.findById(report.agencyId)
      .select('brand marca fileNameCode reviewPeriods')
      .lean();
    if (!report.agencyBrandSnapshot || !report.agencyFileNameCodeSnapshot) {
      report.agencyBrandSnapshot ||= agency?.brand || agency?.marca || '';
      report.agencyFileNameCodeSnapshot ||= agency?.fileNameCode || '';
    }
    const intervalMonths = getReviewIntervalMonths(agency?.reviewPeriods, 'seguridad');
    generationStage = 'sincronizar REP mensual';
    await syncRepReportMonthlyFile(report, { syncExcel: false });
    if (!anx.totalImagenes || anx.totalImagenes !== anx.imagenes.length) {
      throw new AnxPowerPointError('El total de imágenes de ANX no coincide con sus registros.');
    }
    const drive = createGoogleDriveClient();
    generationStage = 'descargar fotos de Drive';
    const images = await Promise.all(anx.imagenes.map((image) => downloadAnxImage(drive, image)));
    generationStage = 'descargar logotipo';
    const logo = await getBrandLogo(drive, report.agencyBrandSnapshot);
    generationStage = 'generar PowerPoint';
    const buffer = await generateAnxPowerPointBuffer(images, {
      logoBuffer: logo.buffer,
      logoMimeType: logo.mimeType,
    });
    generationStage = 'preparar carpeta de Drive';
    const folderId = await ensureRepFolder(drive, report);
    generationStage = 'subir PowerPoint a Drive';
    const stored = await retryTransientGoogleDriveOperation(() => uploadRepAnxToDrive(drive, {
      folderId,
      reportId: report.reportId,
      revision,
      fileName: buildAnxFileName(report, intervalMonths),
      buffer,
    }), {
      attempts: 4,
      delayMs: 5_000,
      onRetry: ({ attempt, status, error }) => logConsoleEvent('rep_anx_drive_retry', {
        reportId: report.reportId,
        stage: generationStage,
        attempt,
        status: status || getGoogleDriveErrorStatus(error),
      }),
    });
    generationStage = 'actualizar REP';
    const reportUpdate = await RepReport.updateOne(
      { _id: report._id, revision },
      {
        $set: {
          'drive.generatedFolderId': folderId,
          agencyBrandSnapshot: report.agencyBrandSnapshot,
          agencyFileNameCodeSnapshot: report.agencyFileNameCodeSnapshot,
        },
      },
    );
    if (reportUpdate.matchedCount !== 1) {
      throw new AnxPowerPointError('El REP cambió durante la generación; vuelve a validar el reporte.');
    }
    generationStage = 'confirmar ANX';
    const anxUpdate = await ANX.updateOne(
      {
        _id: anx._id,
        'archivoGenerado.revision': revision,
        'archivoGenerado.estado': 'processing',
      },
      {
        $set: {
          estado: 'completado',
          'archivoGenerado.estado': 'ready',
          'archivoGenerado.driveFileId': stored.driveFileId,
          'archivoGenerado.nombre': stored.fileName,
          'archivoGenerado.startedAt': null,
          'archivoGenerado.generadoEn': new Date(),
          'archivoGenerado.error': '',
        },
      },
    );
    if (anxUpdate.modifiedCount !== 1) {
      throw new AnxPowerPointError('El estado del ANX cambió durante la generación; vuelve a intentarlo.');
    }
    report.drive = { ...report.drive, generatedFolderId: folderId };
    anx.archivoGenerado = {
      ...anx.archivoGenerado,
      estado: 'ready',
      driveFileId: stored.driveFileId,
      nombre: stored.fileName,
    };
    generationStage = 'sincronizar REP mensual';
    await syncRepReportMonthlyFile(report, { syncExcel: false });
    logConsoleEvent('rep_anx_ready', { reportId: report.reportId, reportRevision: revision });
  } catch (error) {
    try {
      await setGenerationFailure(anx, report, revision, error, generationStage);
    } catch (persistError) {
      logConsoleEvent('rep_anx_failure_state_failed', {
        reportId: anx.reporteId,
        message: persistError.message,
      });
    }
  }
}

async function requeueStaleAnxJobs() {
  await ANX.updateMany(
    {
      'archivoGenerado.estado': 'processing',
      'archivoGenerado.startedAt': { $lt: new Date(Date.now() - STALE_PROCESSING_MS) },
    },
    {
      $set: {
        'archivoGenerado.estado': 'queued',
        'archivoGenerado.startedAt': null,
        'archivoGenerado.error': 'Se reintentó la generación después de una interrupción del servidor.',
      },
    },
  );
}

async function processQueuedAnx() {
  kickGenerationQueue();
}

async function enqueueRepAnxForReport(report, userId) {
  const anx = await ANX.findOne({ reporteId: report.reportId });
  if (!anx?.totalImagenes) return null;
  if (anx.totalImagenes !== anx.imagenes.length) {
    throw new AnxPowerPointError('El total de imágenes de ANX no coincide con sus registros.');
  }
  const generated = anx.archivoGenerado || {};
  const agency = await Agency.findById(report.agencyId).select('fileNameCode reviewPeriods').lean();
  const expectedFileName = buildAnxFileName({
    generalData: report.generalData,
    agencyFileNameCodeSnapshot: report.agencyFileNameCodeSnapshot || agency?.fileNameCode || '',
  }, getReviewIntervalMonths(agency?.reviewPeriods, 'seguridad'));
  if (generated.estado === 'ready'
    && generated.revision === report.revision
    && generated.driveFileId
    && generated.nombre === expectedFileName) return anx;
  if (['queued', 'processing'].includes(generated.estado)
    && generated.revision === report.revision) return anx;

  anx.archivoGenerado = {
    estado: 'queued',
    revision: report.revision,
    driveFileId: '',
    nombre: expectedFileName,
    queuedAt: new Date(),
    startedAt: null,
    generadoEn: null,
    error: '',
  };
  await anx.save();
  await enqueueGeneration({
    type: 'ANX',
    entityId: anx._id,
    reportId: report.reportId,
    revision: report.revision,
    userId,
  });
  await syncRepReportMonthlyFile(report, { syncExcel: false });
  kickRepAnxWorker();
  return anx;
}

function kickRepAnxWorker() {
  kickGenerationQueue();
}

async function startRepAnxWorker() {
  await requeueStaleAnxJobs();
  registerGenerationProcessor('ANX', async (job, logStep) => {
    await logStep('loading_anx', 'processing', 'Cargando fotografías y revisión del reporte.');
    const anx = await ANX.findById(job.entityId);
    if (!anx || anx.archivoGenerado.revision !== job.revision) {
      throw new Error('El ANX ya no corresponde a la revisión en cola.');
    }
    await ANX.updateOne(
      { _id: anx._id, 'archivoGenerado.revision': job.revision },
      { $set: { 'archivoGenerado.estado': 'processing', 'archivoGenerado.startedAt': new Date(), 'archivoGenerado.error': '' } },
    );
    anx.archivoGenerado.estado = 'processing';
    await logStep('generating_powerpoint', 'processing', 'Generando la presentación PowerPoint.');
    await processClaimedAnx(anx);
    const current = await ANX.findById(anx._id).select('archivoGenerado.estado archivoGenerado.error').lean();
    if (current?.archivoGenerado?.estado !== 'ready') {
      await ANX.updateOne(
        { _id: anx._id, 'archivoGenerado.revision': job.revision },
        { $set: {
          'archivoGenerado.estado': job.attempts >= 3 ? 'failed' : 'queued',
          'archivoGenerado.startedAt': null,
        } },
      );
      throw new Error(current?.archivoGenerado?.error || 'No se confirmó la generación ANX.');
    }
    await logStep('file_verified', 'processing', 'Archivo y estado de generación confirmados.');
  });
  const queued = await ANX.find({ 'archivoGenerado.estado': 'queued' })
    .select('_id reporteId archivoGenerado.revision')
    .lean();
  for (const anx of queued) {
    await enqueueGeneration({
      type: 'ANX',
      entityId: anx._id,
      reportId: anx.reporteId,
      revision: anx.archivoGenerado.revision,
    });
  }
}

module.exports = {
  enqueueRepAnxForReport,
  kickRepAnxWorker,
  processClaimedAnx,
  startRepAnxWorker,
};
