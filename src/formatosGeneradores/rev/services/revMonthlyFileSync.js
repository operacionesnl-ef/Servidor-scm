'use strict';

const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const { hasIndependentDriveFile } = require('../../../utils/monthlyFileSources');
const { buildDownloadFileName, TEMPLATE_VERSION } = require('./revExcelGenerator');

async function syncRevReportMonthlyFile(report) {
  const filter = { agencyId: report.agencyId, period: report.generalData.inspectionDate.slice(0, 7) };
  const generated = report.generatedExcel || {};
  const isCurrent = generated.status === 'ready'
    && generated.reportRevision === report.revision
    && generated.templateVersion === TEMPLATE_VERSION
    && Boolean(generated.driveFileId);
  const name = generated.downloadFileName || buildDownloadFileName(report);
  const systemDriveId = isCurrent ? generated.driveFileId : '';
  const systemRuta = isCurrent ? report.drive?.generatedFolderId || '' : '';
  const existing = await AgencyMonthlyFiles.findOne(filter).select('archivos.archivo4').lean();
  const currentFile = existing?.archivos?.archivo4;
  const hasDriveFile = hasIndependentDriveFile(currentFile);
  const systemFields = {
    systemReportId: report.reportId,
    generatedExcelStatus: isCurrent
      ? 'ready'
      : generated.status === 'ready' ? 'not_requested' : generated.status || 'not_requested',
    generatedExcelError: generated.error || '',
    generatedExcelTemplateVersion: isCurrent ? generated.templateVersion : '',
    reportRevision: report.revision,
    generatedExcelRevision: isCurrent ? report.revision : 0,
    systemNombre: name,
    systemDriveId,
    systemRuta,
  };
  const systemFile = {
    mode: 'system',
    ...systemFields,
    nombre: name,
    driveId: systemDriveId,
    ruta: systemRuta,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const setFields = hasDriveFile
    ? Object.fromEntries(Object.entries(systemFields)
      .map(([field, value]) => [`archivos.archivo4.${field}`, value]))
    : { 'archivos.archivo4': systemFile };

  await AgencyMonthlyFiles.findOneAndUpdate(
    filter,
    { $set: { ...setFields, updatedBy: report.updatedBy || report.createdBy } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

module.exports = { syncRevReportMonthlyFile };
