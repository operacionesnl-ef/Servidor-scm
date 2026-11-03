'use strict';

const { Readable } = require('node:stream');
const { getGoogleDriveOAuthConfig } = require('../../../config/googleDrive');
const {
  findDriveFileByAppProperties,
  findOrCreateFolder,
  uploadDriveFile,
} = require('../../../services/googleDriveService');

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GENERATED_FILE_PROPERTIES = {
  efcoreGeneratedExcel: 'FOR-AUD-AMB',
};

class ForReportDriveStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForReportDriveStorageError';
  }
}

async function ensureGeneratedExcelFolder(drive, report) {
  const { rootFolderId } = getGoogleDriveOAuthConfig();
  if (!rootFolderId) {
    throw new ForReportDriveStorageError('Falta configurar la carpeta raíz de Google Drive.');
  }
  const brand = String(report.agencyBrandSnapshot || '').trim();
  if (!brand) {
    throw new ForReportDriveStorageError('Configura la marca de la agencia desde el modo Debug antes de generar el Excel.');
  }
  const period = report.agencyPeriod || report.generalData?.inspectionDate?.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) {
    throw new ForReportDriveStorageError('El período del reporte no es válido para crear su carpeta en Drive.');
  }

  let parentId = rootFolderId;
  for (const folderName of [
    'Servicios EF',
    'Recorridos Medio Ambiente',
    period.slice(0, 4),
    period.slice(5, 7),
    brand,
  ]) {
    const folder = await findOrCreateFolder(drive, parentId, folderName);
    parentId = folder.id;
  }
  return parentId;
}

async function uploadGeneratedExcelToDrive(drive, {
  folderId,
  reportId,
  revision,
  fileName,
  buffer,
}) {
  if (!folderId || !reportId || !Number.isInteger(revision) || !fileName || !Buffer.isBuffer(buffer) || !buffer.length) {
    throw new TypeError('Se requieren reporte, revisión, carpeta, nombre y contenido para guardar el Excel en Drive.');
  }

  const appProperties = {
    ...GENERATED_FILE_PROPERTIES,
    efcoreGeneratedReportId: reportId,
    efcoreGeneratedRevision: String(revision),
  };
  const existing = await findDriveFileByAppProperties(
    drive,
    null,
    {
      ...GENERATED_FILE_PROPERTIES,
      efcoreGeneratedReportId: reportId,
    },
  );
  if (existing) {
    const existingRevision = Number(existing.appProperties?.efcoreGeneratedRevision) || 0;
    if (existingRevision > revision) {
      throw new ForReportDriveStorageError('Drive ya contiene una revisión posterior del reporte.');
    }

    const parents = existing.parents || [];
    const request = {
      fileId: existing.id,
      supportsAllDrives: true,
      requestBody: { name: fileName, appProperties },
      media: { mimeType: XLSX_MIME_TYPE, body: Readable.from([buffer]) },
      fields: 'id,name,mimeType,parents,size,md5Checksum,appProperties',
    };
    if (!parents.includes(folderId)) {
      request.addParents = folderId;
      if (parents.length) request.removeParents = parents.join(',');
    }
    const { data } = await drive.files.update(request);
    return { driveFileId: data.id, folderId, fileName: data.name || fileName };
  }

  const file = await uploadDriveFile(drive, {
    folderId,
    fileName,
    mimeType: XLSX_MIME_TYPE,
    body: Readable.from([buffer]),
    appProperties,
  });
  return { driveFileId: file.id, folderId, fileName: file.name || fileName };
}

module.exports = {
  ForReportDriveStorageError,
  ensureGeneratedExcelFolder,
  uploadGeneratedExcelToDrive,
};
