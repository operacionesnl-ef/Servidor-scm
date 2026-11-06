'use strict';

const ANX = require('../models/ANX');
const RepReport = require('../models/RepReport');
const Agency = require('../../../models/Agency');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const { shouldPauseComplexJobs } = require('../../../services/resourceMonitor');
const {
  AnxPowerPointError,
  buildAnxFileName,
  generateAnxPowerPointBuffer,
} = require('../../anx/services/anxPowerPointGenerator');
const { syncRepReportMonthlyFile } = require('./repMonthlyFileSync');
const {
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
    return { numero: image.numero, mimeType: image.mimeType, buffer: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timeout);
  }
}

async function setGenerationFailure(anx, report, revision, error) {
  const message = error instanceof AnxPowerPointError
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
  if (result.modifiedCount === 1 && report) await syncRepReportMonthlyFile(report);
  logConsoleEvent('rep_anx_failed', {
    reportId: anx.reporteId,
    reportRevision: revision,
    message,
    persisted: result.modifiedCount === 1,
  });
}

async function processClaimedAnx(anx) {
  const revision = anx.archivoGenerado.revision;
  const heartbeat = setInterval(() => {
    ANX.updateOne(
      { _id: anx._id, 'archivoGenerado.revision': revision, 'archivoGenerado.estado': 'processing' },
      { $set: { 'archivoGenerado.startedAt': new Date() } },
    ).catch((error) => {
      logConsoleEvent('rep_anx_heartbeat_failed', { reportId: anx.reporteId, message: error.message });
    });
  }, 60_000);
  heartbeat.unref?.();

  let report = null;
  try {
    report = await RepReport.findOne({ reportId: anx.reporteId });
    if (!report || report.revision !== revision) {
      throw new AnxPowerPointError('El REP cambió durante la generación; vuelve a validar el reporte.');
    }
    if (!report.agencyBrandSnapshot || !report.agencyFileNameCodeSnapshot) {
      const agency = await Agency.findById(report.agencyId)
        .select('brand marca fileNameCode')
        .lean();
      report.agencyBrandSnapshot ||= agency?.brand || agency?.marca || '';
      report.agencyFileNameCodeSnapshot ||= agency?.fileNameCode || '';
    }
    await syncRepReportMonthlyFile(report);
    if (!anx.totalImagenes || anx.totalImagenes !== anx.imagenes.length) {
      throw new AnxPowerPointError('El total de imágenes de ANX no coincide con sus registros.');
    }
    const drive = createGoogleDriveClient();
    const images = await Promise.all(anx.imagenes.map((image) => downloadAnxImage(drive, image)));
    const logo = await getBrandLogo(drive, report.agencyBrandSnapshot);
    const buffer = await generateAnxPowerPointBuffer(images, {
      logoBuffer: logo.buffer,
      logoMimeType: logo.mimeType,
    });
    const folderId = await ensureRepFolder(drive, report);
    const stored = await uploadRepAnxToDrive(drive, {
      folderId,
      reportId: report.reportId,
      revision,
      fileName: buildAnxFileName(report),
      buffer,
    });
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
    await syncRepReportMonthlyFile(report);
    logConsoleEvent('rep_anx_ready', { reportId: report.reportId, reportRevision: revision });
  } catch (error) {
    try {
      await setGenerationFailure(anx, report, revision, error);
    } catch (persistError) {
      logConsoleEvent('rep_anx_failure_state_failed', {
        reportId: anx.reporteId,
        message: persistError.message,
      });
    }
  } finally {
    clearInterval(heartbeat);
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
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (!shouldPauseComplexJobs()) {
      const anx = await ANX.findOneAndUpdate(
        { 'archivoGenerado.estado': 'queued' },
        {
          $set: {
            'archivoGenerado.estado': 'processing',
            'archivoGenerado.startedAt': new Date(),
            'archivoGenerado.error': '',
          },
        },
        { sort: { 'archivoGenerado.queuedAt': 1 }, new: true },
      );
      if (!anx) break;
      await processClaimedAnx(anx);
    }
  })().finally(() => { workerPromise = null; });
  return workerPromise;
}

function kickRepAnxWorker() {
  processQueuedAnx().catch((error) => {
    logConsoleEvent('rep_anx_worker_failed', { message: error.message });
  });
}

async function startRepAnxWorker() {
  await requeueStaleAnxJobs();
  kickRepAnxWorker();
  if (!pollTimer) {
    pollTimer = setInterval(async () => {
      try {
        await requeueStaleAnxJobs();
        await processQueuedAnx();
      } catch (error) {
        logConsoleEvent('rep_anx_worker_failed', { message: error.message });
      }
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }
}

module.exports = {
  kickRepAnxWorker,
  processClaimedAnx,
  startRepAnxWorker,
};
