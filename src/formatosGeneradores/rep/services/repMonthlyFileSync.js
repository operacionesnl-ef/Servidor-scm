'use strict';

const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const { buildDownloadFileName, TEMPLATE_VERSION } = require('./repExcelGenerator');

async function syncRepReportMonthlyFile(report) {
  const period = report.generalData.inspectionDate.slice(0, 7);
  const generated = report.generatedExcel || {};
  const isCurrent = generated.status === 'ready'
    && generated.reportRevision === report.revision
    && generated.templateVersion === TEMPLATE_VERSION
    && Boolean(generated.driveFileId);
  const file = {
    mode: 'system',
    systemReportId: report.reportId,
    nombre: generated.downloadFileName || buildDownloadFileName(report),
    generatedExcelStatus: isCurrent
      ? 'ready'
      : generated.status === 'ready' ? 'not_requested' : generated.status || 'not_requested',
    generatedExcelError: generated.error || '',
    generatedExcelTemplateVersion: isCurrent ? generated.templateVersion : '',
    driveId: isCurrent ? generated.driveFileId : '',
    ruta: isCurrent ? report.drive?.generatedFolderId || '' : '',
    reportRevision: report.revision,
    generatedExcelRevision: isCurrent ? report.revision : 0,
  };
  await AgencyMonthlyFiles.findOneAndUpdate(
    {
      agencyId: report.agencyId,
      period,
      $or: [
        { 'archivos.archivo3': null },
        { 'archivos.archivo3.mode': 'system', 'archivos.archivo3.systemReportId': report.reportId },
      ],
    },
    {
      $set: {
        'archivos.archivo3': file,
        updatedBy: report.updatedBy || report.createdBy,
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

module.exports = { syncRepReportMonthlyFile };
