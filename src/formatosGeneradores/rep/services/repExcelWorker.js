'use strict';

const RepReport = require('../models/RepReport');
const Agency = require('../../../models/Agency');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const {
  getGoogleDriveErrorStatus,
  retryTransientGoogleDriveOperation,
} = require('../../../services/googleDriveService');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const { shouldPauseComplexJobs } = require('../../../services/resourceMonitor');
const {
  enqueueGeneration,
  kickGenerationQueue,
  registerGenerationProcessor,
} = require('../../services/generationQueue');
const { generateRepExcelBuffer, RepExcelError, TEMPLATE_VERSION } = require('./repExcelGenerator');
const { syncRepReportMonthlyFile } = require('./repMonthlyFileSync');
const { enqueueRepAnxForReport } = require('./repAnxWorker');
const { getReviewIntervalMonths } = require('../../../utils/reviewPeriod');
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
  const rawMessage = String(error?.message || 'No se pudo generar el REP.');
  const isHtmlResponse = /^\s*(?:<!doctype html|<html\b)/i.test(rawMessage);
  const status = getGoogleDriveErrorStatus(error);
  const message = (isHtmlResponse
    ? `Google Drive respondió con HTTP ${status || 502} durante la generación del Excel REP.`
    : rawMessage).slice(0, 1000);
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

  try {
    if (report.revision !== revision) return;
    const agency = await Agency.findById(report.agencyId)
      .select('razonSocial direccion entidadFederativa brand marca fileNameCode reviewPeriods')
      .lean();
    report.agencyBrandSnapshot ||= agency?.brand || agency?.marca || '';
    report.agencyFileNameCodeSnapshot ||= agency?.fileNameCode || '';
    report.agencyAddressSnapshot ||= agency?.direccion || '';
    report.agencyLegalNameSnapshot ||= agency?.razonSocial || '';
    const intervalMonths = getReviewIntervalMonths(agency?.reviewPeriods, 'seguridad');
    const drive = createGoogleDriveClient();
    const retryDriveOperation = (stage, operation) => retryTransientGoogleDriveOperation(operation, {
      onRetry: ({ attempt, status }) => logConsoleEvent('rep_excel_drive_retry', {
        reportId: report.reportId,
        stage,
        attempt,
        status,
      }),
    });
    const logo = await retryDriveOperation(
      'brand_logo',
      () => getBrandLogo(drive, report.agencyBrandSnapshot),
    );
    const generated = await generateRepExcelBuffer(report, {
      logoBuffer: logo.buffer,
      logoMimeType: logo.mimeType,
      intervalMonths,
    });
    if (generated.templateVersion !== TEMPLATE_VERSION) {
      throw new RepExcelError('La versión de plantilla REP generada no coincide con la versión activa.');
    }
    const folderId = await retryDriveOperation('generated_folder', () => ensureRepFolder(drive, report));
    const stored = await retryDriveOperation('upload_excel', () => uploadRepExcelToDrive(drive, {
      folderId,
      reportId: report.reportId,
      revision,
      fileName: generated.downloadFileName,
      buffer: generated.buffer,
    }));
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
  kickGenerationQueue();
}

function kickRepExcelWorker() {
  kickGenerationQueue();
}

async function startRepExcelWorker() {
  await requeueStaleRepJobs();
  registerGenerationProcessor('REP', async (job, logStep) => {
    await logStep('loading_report', 'processing', 'Cargando reporte y revisión solicitada.');
    const report = await RepReport.findById(job.entityId);
    if (!report || report.revision !== job.revision) throw new Error('El REP ya no corresponde a la revisión en cola.');
    await RepReport.updateOne(
      { _id: report._id, revision: job.revision },
      { $set: { 'generatedExcel.status': 'processing', 'generatedExcel.startedAt': new Date(), 'generatedExcel.error': '' } },
    );
    report.generatedExcel.status = 'processing';
    await logStep('generating_excel', 'processing', 'Generando el libro Excel.');
    await processClaimedReport(report);
    const current = await RepReport.findById(report._id).select('generatedExcel.status generatedExcel.error').lean();
    if (current?.generatedExcel?.status !== 'ready') {
      await RepReport.updateOne(
        { _id: report._id, revision: job.revision },
        { $set: {
          'generatedExcel.status': job.attempts >= 3 ? 'failed' : 'queued',
          'generatedExcel.startedAt': null,
        } },
      );
      throw new Error(current?.generatedExcel?.error || 'No se confirmó la generación REP.');
    }
    await enqueueRepAnxForReport(report, report.updatedBy || report.createdBy);
    await logStep('file_verified', 'processing', 'Archivo y estado de generación confirmados.');
  });
  const queued = await RepReport.find({ 'generatedExcel.status': 'queued' })
    .select('_id reportId revision createdBy generatedExcel.reportRevision')
    .lean();
  for (const report of queued) {
    await enqueueGeneration({
      type: 'REP',
      entityId: report._id,
      reportId: report.reportId,
      revision: report.generatedExcel.reportRevision,
      userId: report.createdBy,
    });
  }
}

module.exports = {
  kickRepExcelWorker,
  processClaimedReport,
  startRepExcelWorker,
};
