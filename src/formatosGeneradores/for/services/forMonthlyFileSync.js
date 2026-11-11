'use strict';

const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const { hasIndependentDriveFile } = require('../../../utils/monthlyFileSources');
const { buildDownloadFileName, TEMPLATE_VERSION } = require('./forReportExcelGenerator');

async function syncForReportMonthlyFile(report) {
  const period = report.agencyPeriod || report.generalData.inspectionDate.slice(0, 7);
  const generatedExcelIsCurrent = report.generatedExcel?.status === 'ready'
    && report.generatedExcel.reportRevision === report.revision
    && report.generatedExcel.templateVersion === TEMPLATE_VERSION;
  const name = report.generatedExcel?.downloadFileName || buildDownloadFileName(report);
  const systemDriveId = generatedExcelIsCurrent ? report.generatedExcel.driveFileId || '' : '';
  const systemRuta = generatedExcelIsCurrent ? report.drive?.generatedFolderId || '' : '';
  const existing = await AgencyMonthlyFiles.findOne({
    agencyId: report.agencyId,
    period,
  }).select('archivos.archivo2').lean();
  const currentFile = existing?.archivos?.archivo2;
  const hasDriveFile = hasIndependentDriveFile(currentFile);
  const systemFields = {
    systemReportId: report.reportId,
    generatedExcelStatus: generatedExcelIsCurrent
      ? 'ready'
      : report.generatedExcel?.status === 'ready'
        ? 'not_requested'
        : report.generatedExcel?.status || 'not_requested',
    generatedExcelError: report.generatedExcel?.error || '',
    generatedExcelTemplateVersion: generatedExcelIsCurrent ? report.generatedExcel.templateVersion : '',
    reportRevision: report.revision,
    generatedExcelRevision: generatedExcelIsCurrent ? report.revision : 0,
    systemNombre: name,
    systemDriveId,
    systemRuta,
  };
  const file = {
    mode: 'system',
    ...systemFields,
    nombre: name,
    driveId: systemDriveId,
    ruta: systemRuta,
  };
  const setFields = hasDriveFile
    ? Object.fromEntries(Object.entries(systemFields)
      .map(([field, value]) => [`archivos.archivo2.${field}`, value]))
    : { 'archivos.archivo2': file };

  return AgencyMonthlyFiles.findOneAndUpdate(
    { agencyId: report.agencyId, period },
    { $set: { ...setFields, updatedBy: report.updatedBy || report.createdBy } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

module.exports = { syncForReportMonthlyFile };
