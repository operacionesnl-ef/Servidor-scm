'use strict';

const RevReport = require('../models/RevReport');
const { createGoogleDriveClient } = require('../../../config/googleDrive');
const { getGoogleDriveErrorStatus, retryTransientGoogleDriveOperation } = require('../../../services/googleDriveService');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const { shouldPauseComplexJobs } = require('../../../services/resourceMonitor');
const { generateRevExcelBuffer, RevExcelError, TEMPLATE_VERSION } = require('./revExcelGenerator');
const { syncRevReportMonthlyFile } = require('./revMonthlyFileSync');
const { ensureRevFolder, getBrandLogo, uploadRevExcelToDrive } = require('./revDriveStorage');

const STALE_PROCESSING_MS = 5 * 60 * 1000;
let workerPromise = null;
let pollTimer = null;

async function processClaimedReport(report) {
  const revision = report.generatedExcel.reportRevision;
  try {
    if (report.revision !== revision) return;
    const drive = createGoogleDriveClient();
    const retryDriveOperation = (stage, operation) => retryTransientGoogleDriveOperation(operation, {
      onRetry: ({ attempt, status }) => logConsoleEvent('rev_excel_drive_retry', {
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
    const generated = await generateRevExcelBuffer(report, {
      logoBuffer: logo.buffer,
      logoMimeType: logo.mimeType,
    });
    const folderId = await retryDriveOperation('generated_folder', () => ensureRevFolder(drive, report));
    const stored = await retryDriveOperation('upload_excel', () => uploadRevExcelToDrive(drive, {
      folderId,
      reportId: report.reportId,
      revision,
      fileName: generated.downloadFileName,
      buffer: generated.buffer,
    }));
    const result = await RevReport.updateOne(
      { _id: report._id, revision, 'generatedExcel.status': 'processing', 'generatedExcel.reportRevision': revision },
      { $set: {
        'generatedExcel.status': 'ready',
        'generatedExcel.templateVersion': generated.templateVersion,
        'generatedExcel.driveFileId': stored.driveFileId,
        'generatedExcel.downloadFileName': stored.fileName,
        'generatedExcel.generatedAt': new Date(),
        'generatedExcel.startedAt': null,
        'generatedExcel.error': '',
        'drive.generatedFolderId': stored.folderId,
      } },
    );
    if (result.modifiedCount !== 1) throw new RevExcelError('El REV cambió durante la generación; solicita una nueva generación.');
    report.generatedExcel.status = 'ready';
    report.generatedExcel.templateVersion = generated.templateVersion;
    report.generatedExcel.driveFileId = stored.driveFileId;
    report.generatedExcel.downloadFileName = stored.fileName;
    report.drive.generatedFolderId = stored.folderId;
    await syncRevReportMonthlyFile(report);
  } catch (error) {
    const status = getGoogleDriveErrorStatus(error);
    const rawMessage = String(error?.message || `Error de Google Drive HTTP ${status || 502}.`);
    const isHtmlResponse = /^\s*(?:<!doctype html|<html\b)/i.test(rawMessage);
    const message = (isHtmlResponse
      ? `Google Drive respondió con HTTP ${status || 502} durante la generación del Excel REV.`
      : rawMessage).slice(0, 1000);
    const result = await RevReport.updateOne(
      { _id: report._id, revision, 'generatedExcel.status': 'processing', 'generatedExcel.reportRevision': revision },
      { $set: { 'generatedExcel.status': 'failed', 'generatedExcel.driveFileId': '', 'generatedExcel.error': message, 'generatedExcel.startedAt': null } },
    );
    if (result.modifiedCount) {
      report.generatedExcel.status = 'failed';
      report.generatedExcel.error = message;
      report.generatedExcel.driveFileId = '';
      await syncRevReportMonthlyFile(report);
    }
    logConsoleEvent('rev_excel_failed', { reportId: report.reportId, message });
  }
}

async function processQueuedRevReports() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (!shouldPauseComplexJobs()) {
      const report = await RevReport.findOneAndUpdate(
        { 'generatedExcel.status': 'queued' },
        { $set: { 'generatedExcel.status': 'processing', 'generatedExcel.startedAt': new Date() } },
        { sort: { 'generatedExcel.queuedAt': 1 }, new: true },
      );
      if (!report) break;
      await processClaimedReport(report);
    }
  })().finally(() => { workerPromise = null; });
  return workerPromise;
}

function kickRevExcelWorker() {
  processQueuedRevReports().catch((error) => logConsoleEvent('rev_excel_worker_failed', { message: error.message }));
}

async function startRevExcelWorker() {
  await RevReport.updateMany(
    { 'generatedExcel.status': 'processing', 'generatedExcel.startedAt': { $lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    { $set: { 'generatedExcel.status': 'queued', 'generatedExcel.startedAt': null } },
  );
  kickRevExcelWorker();
  if (!pollTimer) {
    pollTimer = setInterval(kickRevExcelWorker, 1500);
    pollTimer.unref?.();
  }
}

module.exports = { kickRevExcelWorker, processQueuedRevReports, startRevExcelWorker };
