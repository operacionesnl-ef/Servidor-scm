'use strict';

const fs = require('node:fs/promises');
const ForReport = require('../models/ForReport');
const { createGoogleDriveClient } = require('../config/googleDrive');
const {
  generateForReportExcelBuffer,
  TEMPLATE_VERSION,
} = require('./forReportExcelGenerator');
const {
  getOutputDirectory,
  removeGeneratedForReportExcel,
  storeGeneratedForReportExcel,
} = require('./forReportExcelFileStore');
const { logConsoleEvent } = require('../utils/serverLogger');

const POLL_INTERVAL_MS = 1500;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const MAX_LOCAL_REVISIONS_PER_REPORT = 5;

let workerPromise = null;
let pollTimer = null;

function reportHasDriveImages(report) {
  return (report.evidence || []).some((entry) => (
    entry.status === 'active'
    && (entry.images || []).some((image) => image.status === 'active' && image.driveFileId)
  ));
}

async function pruneOldRevisions(reportId, currentFileName) {
  const directory = getOutputDirectory();
  const filenamePrefix = `${reportId}-rev-`;
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const files = names
    .filter((name) => name.startsWith(filenamePrefix) && name.endsWith('.xlsx'))
    .map((name) => ({
      name,
      revision: Number(name.slice(filenamePrefix.length, -5)),
    }))
    .filter(({ revision }) => Number.isInteger(revision))
    .sort((left, right) => right.revision - left.revision);
  const retained = new Set([currentFileName, ...files
    .filter(({ name }) => name !== currentFileName)
    .slice(0, MAX_LOCAL_REVISIONS_PER_REPORT - 1)
    .map(({ name }) => name)]);
  for (const { name } of files) {
    if (!retained.has(name)) await removeGeneratedForReportExcel(name);
  }
}

async function recordGenerationFailure(report, revision, error) {
  const message = String(error?.message || 'No se pudo generar y verificar el archivo Excel.').slice(0, 1000);
  const result = await ForReport.updateOne(
    {
      _id: report._id,
      revision,
      'generatedExcel.reportRevision': revision,
      'generatedExcel.status': 'processing',
    },
    {
      $set: {
        'generatedExcel.status': 'failed',
        'generatedExcel.error': message,
        'generatedExcel.startedAt': null,
      },
    },
  );
  logConsoleEvent('for_report_excel_failed', {
    reportId: report.reportId,
    reportRevision: revision,
    message,
    persisted: result.modifiedCount === 1,
  });
}

async function processClaimedReport(report) {
  const revision = report.generatedExcel.reportRevision;
  const heartbeat = setInterval(() => {
    ForReport.updateOne(
      {
        _id: report._id,
        revision,
        'generatedExcel.reportRevision': revision,
        'generatedExcel.status': 'processing',
      },
      { $set: { 'generatedExcel.startedAt': new Date() } },
    ).catch((error) => {
      logConsoleEvent('for_report_excel_heartbeat_failed', {
        reportId: report.reportId,
        reportRevision: revision,
        message: error.message,
      });
    });
  }, 60_000);
  heartbeat.unref?.();

  let storedFileName = '';
  try {
    if (report.revision !== revision) return;
    const drive = reportHasDriveImages(report) ? createGoogleDriveClient() : null;
    const generated = await generateForReportExcelBuffer(report, drive);
    if (generated.templateVersion !== TEMPLATE_VERSION) {
      throw new Error('La versión de plantilla generada no coincide con la versión activa.');
    }
    const stored = await storeGeneratedForReportExcel(generated.fileName, generated.buffer);
    storedFileName = stored.localFileName;
    const result = await ForReport.updateOne(
      {
        _id: report._id,
        revision,
        'generatedExcel.reportRevision': revision,
        'generatedExcel.status': 'processing',
      },
      {
        $set: {
          'generatedExcel.status': 'ready',
          'generatedExcel.templateVersion': generated.templateVersion,
          'generatedExcel.storageProvider': stored.storageProvider,
          'generatedExcel.localFileName': stored.localFileName,
          'generatedExcel.driveFileId': '',
          'generatedExcel.generatedAt': new Date(),
          'generatedExcel.startedAt': null,
          'generatedExcel.error': '',
        },
      },
    );
    if (result.modifiedCount !== 1) {
      await removeGeneratedForReportExcel(stored.localFileName);
      storedFileName = '';
      return;
    }
    await pruneOldRevisions(report.reportId, stored.localFileName);
    logConsoleEvent('for_report_excel_ready', {
      reportId: report.reportId,
      reportRevision: revision,
      imageCount: generated.imageCount,
    });
  } catch (error) {
    if (storedFileName) {
      try {
        await removeGeneratedForReportExcel(storedFileName);
      } catch (cleanupError) {
        logConsoleEvent('for_report_excel_cleanup_failed', {
          reportId: report.reportId,
          reportRevision: revision,
          message: cleanupError.message,
        });
      }
    }
    try {
      await recordGenerationFailure(report, revision, error);
    } catch (recordError) {
      logConsoleEvent('for_report_excel_failure_state_failed', {
        reportId: report.reportId,
        reportRevision: revision,
        message: recordError.message,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function requeueStaleProcessingReports() {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  await ForReport.updateMany(
    {
      'generatedExcel.status': 'processing',
      'generatedExcel.startedAt': { $lt: staleBefore },
    },
    {
      $set: {
        'generatedExcel.status': 'queued',
        'generatedExcel.startedAt': null,
        'generatedExcel.error': 'Se reintentó la generación después de una interrupción del servidor.',
      },
    },
  );
}

async function processQueuedReports() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (true) {
      const report = await ForReport.findOneAndUpdate(
        { 'generatedExcel.status': 'queued' },
        {
          $set: {
            'generatedExcel.status': 'processing',
            'generatedExcel.startedAt': new Date(),
            'generatedExcel.error': '',
          },
        },
        { sort: { 'generatedExcel.queuedAt': 1 }, new: true },
      );
      if (!report) break;
      await processClaimedReport(report);
    }
  })().finally(() => { workerPromise = null; });
  return workerPromise;
}

function kickForReportExcelWorker() {
  processQueuedReports().catch((error) => {
    logConsoleEvent('for_report_excel_worker_failed', { message: error.message });
  });
}

async function startForReportExcelWorker() {
  await requeueStaleProcessingReports();
  kickForReportExcelWorker();
  if (!pollTimer) {
    pollTimer = setInterval(async () => {
      try {
        await requeueStaleProcessingReports();
        await processQueuedReports();
      } catch (error) {
        logConsoleEvent('for_report_excel_worker_failed', { message: error.message });
      }
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }
}

module.exports = {
  kickForReportExcelWorker,
  startForReportExcelWorker,
};
