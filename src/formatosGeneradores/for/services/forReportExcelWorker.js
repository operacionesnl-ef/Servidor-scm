'use strict';

const ForReport = require('../models/ForReport');
const Agency = require('../../../models/Agency');
const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const {
  generateForReportExcelBuffer,
  ForReportExcelError,
  TEMPLATE_VERSION,
} = require('./forReportExcelGenerator');
const {
  ensureGeneratedExcelFolder,
  ForReportDriveStorageError,
  uploadGeneratedExcelToDrive,
} = require('./forReportDriveStorage');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const { shouldPauseComplexJobs } = require('../../../services/resourceMonitor');

const POLL_INTERVAL_MS = 1500;
const STALE_PROCESSING_MS = 5 * 60 * 1000;

let workerPromise = null;
let pollTimer = null;

async function recordGenerationFailure(report, revision, error) {
  const message = String(error?.message || 'No se pudo generar y verificar el archivo Excel.').slice(0, 1000);
  const result = await ForReport.updateOne(
    {
      _id: report._id,
      revision,
      'generatedExcel.reportRevision': revision,
      'generatedExcel.status': { $in: ['processing', 'ready'] },
    },
    {
      $set: {
        'generatedExcel.status': 'failed',
        'generatedExcel.error': message,
        'generatedExcel.localFileName': '',
        'generatedExcel.driveFileId': '',
        'generatedExcel.downloadFileName': '',
        'generatedExcel.generatedAt': null,
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

  try {
    if (report.revision !== revision) return;
    if (!report.agencyStateSnapshot || !report.agencyFileNameCodeSnapshot || !report.agencyBrandSnapshot) {
      const agency = await Agency.findById(report.agencyId)
        .select('entidadFederativa fileNameCode marca')
        .lean();
      report.agencyStateSnapshot ||= agency?.entidadFederativa || '';
      report.agencyFileNameCodeSnapshot ||= agency?.fileNameCode || '';
      report.agencyBrandSnapshot ||= agency?.marca || '';
    }
    if (!report.agencyBrandSnapshot) {
      throw new ForReportDriveStorageError('Configura la marca de la agencia desde el modo Debug antes de generar el Excel.');
    }
    const drive = createGoogleDriveClient();
    const generated = await generateForReportExcelBuffer(report, drive);
    if (generated.templateVersion !== TEMPLATE_VERSION) {
      throw new Error('La versión de plantilla generada no coincide con la versión activa.');
    }
    const folderId = await ensureGeneratedExcelFolder(drive, report);
    const stored = await uploadGeneratedExcelToDrive(drive, {
      folderId,
      reportId: report.reportId,
      revision,
      fileName: generated.downloadFileName,
      buffer: generated.buffer,
    });
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
          'generatedExcel.storageProvider': 'drive',
          'generatedExcel.localFileName': '',
          'generatedExcel.downloadFileName': generated.downloadFileName,
          'generatedExcel.driveFileId': stored.driveFileId,
          'generatedExcel.generatedAt': new Date(),
          'generatedExcel.startedAt': null,
          'generatedExcel.error': '',
          'drive.generatedFolderId': stored.folderId,
        },
      },
    );
    if (result.modifiedCount !== 1) {
      throw new Error('El reporte cambió durante la generación del Excel; solicita la generación nuevamente.');
    }
    const monthlyUpdate = await AgencyMonthlyFiles.updateOne(
      {
        agencyId: report.agencyId,
        period: report.agencyPeriod || report.generalData.inspectionDate.slice(0, 7),
        'archivos.archivo2.systemReportId': report.reportId,
        'archivos.archivo2.reportRevision': revision,
        'archivos.archivo2.generatedExcelStatus': { $in: ['queued', 'processing'] },
      },
      {
        $set: {
          'archivos.archivo2.nombre': generated.downloadFileName,
          'archivos.archivo2.driveId': stored.driveFileId,
          'archivos.archivo2.ruta': stored.folderId,
          'archivos.archivo2.generatedExcelStatus': 'ready',
          'archivos.archivo2.generatedExcelRevision': revision,
          'archivos.archivo2.generatedExcelError': '',
          'archivos.archivo2.generatedExcelTemplateVersion': generated.templateVersion,
        },
      },
    );
    if (monthlyUpdate.matchedCount === 0) {
      throw new Error('No se encontró el archivo mensual correspondiente al reporte generado.');
    }
    logConsoleEvent('for_report_excel_ready', {
      reportId: report.reportId,
      reportRevision: revision,
      imageCount: generated.imageCount,
    });
  } catch (error) {
    const message = String(error?.message || 'No se pudo generar y verificar el archivo Excel.').slice(0, 1000);
    const publicMessage = error instanceof ForReportExcelError || error instanceof ForReportDriveStorageError
      ? message
      : 'Error interno al generar el Excel. Revisa los registros del servidor.';
    try {
      await recordGenerationFailure(report, revision, error);
      await AgencyMonthlyFiles.updateOne(
        {
          agencyId: report.agencyId,
          period: report.agencyPeriod || report.generalData.inspectionDate.slice(0, 7),
          'archivos.archivo2.systemReportId': report.reportId,
          'archivos.archivo2.reportRevision': revision,
          'archivos.archivo2.generatedExcelStatus': { $in: ['queued', 'processing'] },
        },
        {
          $set: {
            'archivos.archivo2.generatedExcelStatus': 'failed',
            'archivos.archivo2.generatedExcelError': publicMessage,
          },
        },
      );
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

async function invalidateStaleGeneratedExcels() {
  const staleReports = await ForReport.find({
    'generatedExcel.status': 'ready',
    'generatedExcel.templateVersion': { $ne: TEMPLATE_VERSION },
  }).select('_id reportId').lean();
  if (!staleReports.length) return 0;

  const reportIds = staleReports.map(({ reportId }) => reportId);
  const reportResult = await ForReport.updateMany(
    {
      _id: { $in: staleReports.map(({ _id }) => _id) },
      'generatedExcel.status': 'ready',
      'generatedExcel.templateVersion': { $ne: TEMPLATE_VERSION },
    },
    {
      $set: {
        'generatedExcel.status': 'not_requested',
        'generatedExcel.reportRevision': 0,
        'generatedExcel.templateVersion': TEMPLATE_VERSION,
        'generatedExcel.storageProvider': 'drive',
        'generatedExcel.localFileName': '',
        'generatedExcel.driveFileId': '',
        'generatedExcel.downloadFileName': '',
        'generatedExcel.queuedAt': null,
        'generatedExcel.startedAt': null,
        'generatedExcel.generatedAt': null,
        'generatedExcel.error': '',
      },
    },
  );
  await AgencyMonthlyFiles.updateMany(
    { 'archivos.archivo2.systemReportId': { $in: reportIds } },
    {
      $set: {
        'archivos.archivo2.nombre': '',
        'archivos.archivo2.driveId': '',
        'archivos.archivo2.ruta': '',
        'archivos.archivo2.generatedExcelStatus': 'not_requested',
        'archivos.archivo2.generatedExcelRevision': 0,
        'archivos.archivo2.generatedExcelError': '',
        'archivos.archivo2.generatedExcelTemplateVersion': '',
      },
    },
  );
  logConsoleEvent('for_report_excel_template_invalidated', {
    count: reportResult.modifiedCount,
    templateVersion: TEMPLATE_VERSION,
  });
  return reportResult.modifiedCount;
}

async function processQueuedReports() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (true) {
      if (shouldPauseComplexJobs()) break;
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
  await invalidateStaleGeneratedExcels();
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
  invalidateStaleGeneratedExcels,
  startForReportExcelWorker,
};
