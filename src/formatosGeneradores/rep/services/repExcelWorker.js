'use strict';

const RepReport = require('../models/RepReport');
const Agency = require('../../../models/Agency');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const { shouldPauseComplexJobs } = require('../../../services/resourceMonitor');
const { generateRepExcelBuffer, RepExcelError, TEMPLATE_VERSION } = require('./repExcelGenerator');
const { syncRepReportMonthlyFile } = require('./repMonthlyFileSync');
const {
  ensureRepFolder,
  getBrandLogo,
  uploadRepExcelToDrive,
} = require('./repDriveStorage');

const POLL_INTERVAL_MS = 1500;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
let workerPromise = null;
let pollTimer = null;

async function setGenerationFailure(report, revision, error) {
  const message = String(error?.message || 'No se pudo generar el REP.').slice(0, 1000);
  const result = await RepReport.updateOne(
    {
      _id: report._id,
      revision,
      'generatedExcel.reportRevision': revision,
      'generatedExcel.status': 'processing',
    },
    {
      $set: {
        'generatedExcel.status': 'failed',
        'generatedExcel.driveFileId': '',
        'generatedExcel.downloadFileName': '',
        'generatedExcel.startedAt': null,
        'generatedExcel.error': message,
      },
    },
  );
  if (result.modifiedCount === 1) {
    report.generatedExcel = {
      ...report.generatedExcel,
      status: 'failed',
      driveFileId: '',
      downloadFileName: '',
      startedAt: null,
      error: message,
    };
    await syncRepReportMonthlyFile(report);
  }
  logConsoleEvent('rep_excel_failed', {
    reportId: report.reportId,
    reportRevision: revision,
    message,
    persisted: result.modifiedCount === 1,
  });
}

async function processClaimedReport(report) {
  const revision = report.generatedExcel.reportRevision;
  const heartbeat = setInterval(() => {
    RepReport.updateOne(
      { _id: report._id, revision, 'generatedExcel.status': 'processing' },
      { $set: { 'generatedExcel.startedAt': new Date() } },
    ).catch((error) => {
      logConsoleEvent('rep_excel_heartbeat_failed', { reportId: report.reportId, message: error.message });
    });
  }, 60_000);
  heartbeat.unref?.();

  try {
    if (report.revision !== revision) return;
    if (!report.agencyBrandSnapshot || !report.agencyAddressSnapshot
      || !report.agencyLegalNameSnapshot || !report.agencyFileNameCodeSnapshot) {
      const agency = await Agency.findById(report.agencyId)
        .select('razonSocial direccion entidadFederativa brand marca fileNameCode')
        .lean();
      report.agencyBrandSnapshot ||= agency?.brand || agency?.marca || '';
      report.agencyFileNameCodeSnapshot ||= agency?.fileNameCode || '';
      report.agencyAddressSnapshot ||= agency?.direccion || '';
      report.agencyLegalNameSnapshot ||= agency?.razonSocial || '';
    }
    const drive = createGoogleDriveClient();
    const logo = await getBrandLogo(drive, report.agencyBrandSnapshot);
    const generated = await generateRepExcelBuffer(report, {
      logoBuffer: logo.buffer,
      logoMimeType: logo.mimeType,
    });
    if (generated.templateVersion !== TEMPLATE_VERSION) {
      throw new RepExcelError('La versión de plantilla REP generada no coincide con la versión activa.');
    }
    const folderId = await ensureRepFolder(drive, report);
    const stored = await uploadRepExcelToDrive(drive, {
      folderId,
      reportId: report.reportId,
      revision,
      fileName: generated.downloadFileName,
      buffer: generated.buffer,
    });
    const result = await RepReport.updateOne(
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
          'generatedExcel.driveFileId': stored.driveFileId,
          'generatedExcel.downloadFileName': stored.fileName,
          'generatedExcel.generatedAt': new Date(),
          'generatedExcel.startedAt': null,
          'generatedExcel.error': '',
          'drive.generatedFolderId': stored.folderId,
          agencyBrandSnapshot: report.agencyBrandSnapshot,
          agencyAddressSnapshot: report.agencyAddressSnapshot,
          agencyLegalNameSnapshot: report.agencyLegalNameSnapshot,
        },
      },
    );
    if (result.modifiedCount !== 1) {
      throw new RepExcelError('El REP cambió durante la generación; solicita una nueva generación.');
    }
    report.generatedExcel = {
      ...report.generatedExcel,
      status: 'ready',
      templateVersion: generated.templateVersion,
      driveFileId: stored.driveFileId,
      downloadFileName: stored.fileName,
      generatedAt: new Date(),
      startedAt: null,
      error: '',
    };
    report.drive = { ...report.drive, generatedFolderId: stored.folderId };
    await syncRepReportMonthlyFile(report);
    logConsoleEvent('rep_excel_ready', {
      reportId: report.reportId,
      reportRevision: revision,
      findingsCount: report.findings.length,
    });
  } catch (error) {
    try {
      await setGenerationFailure(report, revision, error);
    } catch (persistError) {
      logConsoleEvent('rep_excel_failure_state_failed', {
        reportId: report.reportId,
        message: persistError.message,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function requeueStaleRepJobs() {
  await RepReport.updateMany(
    {
      'generatedExcel.status': 'processing',
      'generatedExcel.startedAt': { $lt: new Date(Date.now() - STALE_PROCESSING_MS) },
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

async function processQueuedRepReports() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (!shouldPauseComplexJobs()) {
      const report = await RepReport.findOneAndUpdate(
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

function kickRepExcelWorker() {
  processQueuedRepReports().catch((error) => {
    logConsoleEvent('rep_excel_worker_failed', { message: error.message });
  });
}

async function startRepExcelWorker() {
  await requeueStaleRepJobs();
  kickRepExcelWorker();
  if (!pollTimer) {
    pollTimer = setInterval(async () => {
      try {
        await requeueStaleRepJobs();
        await processQueuedRepReports();
      } catch (error) {
        logConsoleEvent('rep_excel_worker_failed', { message: error.message });
      }
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }
}

module.exports = {
  kickRepExcelWorker,
  processClaimedReport,
  startRepExcelWorker,
};
