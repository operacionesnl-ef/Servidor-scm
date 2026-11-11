'use strict';

const AgencyMonthlyFiles = require('../../../models/AgencyMonthlyFiles');
const ANX = require('../models/ANX');
const { buildDownloadFileName, TEMPLATE_VERSION } = require('./repExcelGenerator');
const { hasIndependentDriveFile } = require('../../../utils/monthlyFileSources');

async function syncRepReportMonthlyFile(report) {
  const period = report.generalData.inspectionDate.slice(0, 7);
  const anx = await ANX.findOne({ reporteId: report.reportId }).lean();
  const generatedAnx = anx?.archivoGenerado || {};
  const anxReady = generatedAnx.estado === 'ready'
    && generatedAnx.revision === report.revision
    && Boolean(generatedAnx.driveFileId);
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
    systemNombre: generated.downloadFileName || buildDownloadFileName(report),
    systemDriveId: isCurrent ? generated.driveFileId : '',
    systemRuta: isCurrent ? report.drive?.generatedFolderId || '' : '',
    reportRevision: report.revision,
    generatedExcelRevision: isCurrent ? report.revision : 0,
  };
  const anxFile = anx?.totalImagenes ? {
    mode: 'system',
    systemReportId: report.reportId,
    nombre: generatedAnx.nombre || 'ANX-FOT.pptx',
    generatedAnxStatus: anxReady ? 'ready'
      : ['queued', 'processing', 'failed'].includes(generatedAnx.estado) ? generatedAnx.estado : 'not_requested',
    generatedAnxError: generatedAnx.error || '',
    generatedAnxRevision: anxReady ? report.revision : 0,
    generatedExcelStatus: 'not_requested',
    driveId: anxReady ? generatedAnx.driveFileId : '',
    ruta: anxReady ? report.drive?.generatedFolderId || '' : '',
    reportRevision: report.revision,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  } : null;
  const fileFilter = { agencyId: report.agencyId, period };
  const existing = await AgencyMonthlyFiles.findOne(fileFilter).select('archivos.archivo3').lean();
  const currentFile = existing?.archivos?.archivo3;
  const hasDriveFile = hasIndependentDriveFile(currentFile);
  const systemFields = Object.fromEntries(
    Object.entries(file).filter(([field]) => field !== 'mode' && field !== 'nombre' && field !== 'driveId' && field !== 'ruta'),
  );
  const setFields = hasDriveFile
    ? Object.fromEntries(Object.entries(systemFields)
      .map(([field, value]) => [`archivos.archivo3.${field}`, value]))
    : { 'archivos.archivo3': file };
  await AgencyMonthlyFiles.findOneAndUpdate(
    fileFilter,
    { $set: { ...setFields, updatedBy: report.updatedBy || report.createdBy } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
  if (anxFile) {
    const anxFileFilter = {
        agencyId: report.agencyId,
        period,
        ...(anxReady ? {} : {
        $or: [
          { 'archivos.archivo1': null },
          { 'archivos.archivo1.mode': 'system', 'archivos.archivo1.systemReportId': report.reportId },
        ],
        }),
    };
    await AgencyMonthlyFiles.findOneAndUpdate(
      anxFileFilter,
      {
        $set: {
          'archivos.archivo1': anxFile,
          updatedBy: report.updatedBy || report.createdBy,
        },
      },
      { new: true, runValidators: true },
    );
  } else {
    await AgencyMonthlyFiles.findOneAndUpdate(
      {
        agencyId: report.agencyId,
        period,
        'archivos.archivo1.mode': 'system',
        'archivos.archivo1.systemReportId': report.reportId,
      },
      {
        $unset: { 'archivos.archivo1': 1 },
        $set: { updatedBy: report.updatedBy || report.createdBy },
      },
      { new: true, runValidators: true },
    );
  }
}

module.exports = { syncRepReportMonthlyFile };
