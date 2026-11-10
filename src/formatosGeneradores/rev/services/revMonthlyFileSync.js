'use strict';

const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const { buildDownloadFileName, TEMPLATE_VERSION } = require('./revExcelGenerator');

async function syncRevReportMonthlyFile(report) {
  const generated = report.generatedExcel || {};
  const isCurrent = generated.status === 'ready'
    && generated.reportRevision === report.revision
    && generated.templateVersion === TEMPLATE_VERSION
    && Boolean(generated.driveFileId);
  await AgencyMonthlyFiles.findOneAndUpdate(
    { agencyId: report.agencyId, period: report.generalData.inspectionDate.slice(0, 7) },
    {
      $set: {
        'archivos.archivo4': {
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
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        updatedBy: report.updatedBy || report.createdBy,
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

module.exports = { syncRevReportMonthlyFile };
