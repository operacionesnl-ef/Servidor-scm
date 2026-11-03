'use strict';

const { Readable } = require('node:stream');
const { getGoogleDriveOAuthConfig } = require('../../../config/googleDrive');
const {
  findDriveFileByAppProperties,
  findOrCreateFolder,
  uploadDriveFile,
} = require('../../../services/googleDriveService');

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GENERATED_FILE_PROPERTIES = { efcoreGeneratedExcel: 'REP-INS' };

class RepDriveStorageError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'RepDriveStorageError';
  }
}

function normalizeBrand(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function findUniqueFolder(drive, parentId, name) {
  const { data } = await drive.files.list({
    q: `'${parentId.replace(/'/g, "\\'")}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    spaces: 'drive',
    pageSize: 10,
    fields: 'files(id,name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (data.files?.length !== 1) {
    throw new RepDriveStorageError(data.files?.length
      ? `Hay carpetas duplicadas llamadas ${name} en Google Drive.`
      : `No se encontró la carpeta ${name} en Google Drive.`);
  }
  return data.files[0];
}

async function resolveBrandLogo(drive, brandName) {
  const rootFolderId = getGoogleDriveOAuthConfig().rootFolderId;
  if (!rootFolderId) throw new RepDriveStorageError('Falta configurar la carpeta raíz de Google Drive.');
  if (!brandName) throw new RepDriveStorageError('La agencia no tiene una marca configurada para resolver el logo.');
  const resources = await findUniqueFolder(drive, rootFolderId, 'Recursos');
  const logos = await findUniqueFolder(drive, resources.id, 'Logotipos');
  const expectedBrand = normalizeBrand(brandName);
  const { data } = await drive.files.list({
    q: `'${logos.id}' in parents and trashed = false`,
    spaces: 'drive',
    pageSize: 1000,
    fields: 'files(id,name,mimeType,trashed)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const matches = (data.files || []).filter((file) => (
    IMAGE_MIME_TYPES.has(file.mimeType)
    && normalizeBrand(file.name.replace(/\.[^.]+$/, '')) === expectedBrand
  ));
  if (matches.length !== 1) {
    throw new RepDriveStorageError(matches.length
      ? `Hay más de un logo para la marca ${brandName}.`
      : `No se encontró en Recursos/Logotipos una imagen cuyo nombre coincida con la marca ${brandName}.`);
  }
  return matches[0];
}

async function readDriveStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const result = Buffer.concat(chunks);
  if (!result.length) throw new RepDriveStorageError('El archivo de logo en Drive está vacío.');
  return result;
}

async function getBrandLogo(drive, brandName) {
  const file = await resolveBrandLogo(drive, brandName);
  const response = await drive.files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  return {
    buffer: await readDriveStream(response.data),
    mimeType: file.mimeType,
  };
}

async function ensureRepFolder(drive, report) {
  const rootFolderId = getGoogleDriveOAuthConfig().rootFolderId;
  if (!rootFolderId) throw new RepDriveStorageError('Falta configurar la carpeta raíz de Google Drive.');
  const period = report.generalData.inspectionDate.slice(0, 7);
  let parentId = rootFolderId;
  for (const name of ['Servicios EF', 'Reporte Revision Piso', period.slice(0, 4), period.slice(5, 7), report.agencyBrandSnapshot]) {
    if (!name) throw new RepDriveStorageError('La agencia no tiene una marca configurada.');
    parentId = (await findOrCreateFolder(drive, parentId, name)).id;
  }
  return parentId;
}

async function ensureRepImageFolder(drive, report) {
  const reportFolderId = await ensureRepFolder(drive, report);
  return (await findOrCreateFolder(drive, reportFolderId, 'Fotografias')).id;
}

async function uploadRepImageToDrive(drive, { folderId, reportId, findingIndex, imageId, fileName, mimeType, buffer }) {
  if (!folderId || !reportId || !Number.isInteger(findingIndex) || !imageId || !fileName
    || !IMAGE_MIME_TYPES.has(mimeType) || !Buffer.isBuffer(buffer) || !buffer.length) {
    throw new TypeError('Se requieren los datos y el contenido de la foto del hallazgo.');
  }
  const appProperties = {
    efcoreRepImage: 'true',
    efcoreRepReportId: reportId,
    efcoreRepFindingIndex: String(findingIndex),
    efcoreRepImageId: imageId,
  };
  const existing = await findDriveFileByAppProperties(drive, folderId, appProperties);
  if (existing) return existing;
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
  return uploadDriveFile(drive, {
    folderId,
    fileName: `${imageId}.${extension}`,
    mimeType,
    body: Readable.from([buffer]),
    appProperties,
  });
}

async function uploadRepExcelToDrive(drive, { folderId, reportId, revision, fileName, buffer }) {
  if (!folderId || !reportId || !Number.isInteger(revision) || !fileName || !Buffer.isBuffer(buffer) || !buffer.length) {
    throw new TypeError('Se requieren reporte, revisión, carpeta, nombre y contenido para guardar el REP.');
  }
  const appProperties = {
    ...GENERATED_FILE_PROPERTIES,
    efcoreGeneratedReportId: reportId,
    efcoreGeneratedRevision: String(revision),
  };
  const existing = await findDriveFileByAppProperties(drive, null, {
    ...GENERATED_FILE_PROPERTIES,
    efcoreGeneratedReportId: reportId,
  });
  if (existing) {
    const storedRevision = Number(existing.appProperties?.efcoreGeneratedRevision) || 0;
    if (storedRevision > revision) throw new RepDriveStorageError('Drive ya contiene una revisión posterior del REP.');
    const request = {
      fileId: existing.id,
      supportsAllDrives: true,
      requestBody: { name: fileName, appProperties },
      media: { mimeType: XLSX_MIME_TYPE, body: Readable.from([buffer]) },
      fields: 'id,name,parents,appProperties',
    };
    const parents = existing.parents || [];
    if (!parents.includes(folderId)) {
      request.addParents = folderId;
      if (parents.length) request.removeParents = parents.join(',');
    }
    const { data } = await drive.files.update(request);
    return { driveFileId: data.id, folderId, fileName: data.name || fileName };
  }
  const uploaded = await uploadDriveFile(drive, {
    folderId,
    fileName,
    mimeType: XLSX_MIME_TYPE,
    body: Readable.from([buffer]),
    appProperties,
  });
  return { driveFileId: uploaded.id, folderId, fileName: uploaded.name || fileName };
}

module.exports = {
  RepDriveStorageError,
  ensureRepFolder,
  ensureRepImageFolder,
  getBrandLogo,
  normalizeBrand,
  resolveBrandLogo,
  uploadRepExcelToDrive,
  uploadRepImageToDrive,
};
