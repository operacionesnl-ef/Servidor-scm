'use strict';

const { Readable } = require('node:stream');
const { getGoogleDriveOAuthConfig } = require('../../../config/googleDrive');
const BRAND_LOGO_PATHS = require('../../../config/repBrandLogoPaths');
const {
  findDriveFileByAppProperties,
  findOrCreateFolder,
  uploadDriveFile,
} = require('../../../services/googleDriveService');
const { logConsoleEvent } = require('../../../utils/serverLogger');

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GENERATED_FILE_PROPERTIES = { efcoreGeneratedExcel: 'REP-INS' };
const MAX_PUBLIC_LOGO_BYTES = 5 * 1024 * 1024;

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
  logConsoleEvent('rep_logo_folder_lookup', {
    parentId,
    folderName: name,
    matches: (data.files || []).map(({ id, name: folderName }) => ({ id, name: folderName })),
  });
  console.info('[REP Drive] Resultado de búsqueda de carpeta', {
    parentId,
    folderName: name,
    matches: (data.files || []).map(({ id, name: folderName }) => ({ id, name: folderName })),
  });
  if (data.files?.length !== 1) {
    throw new RepDriveStorageError(data.files?.length
      ? `Hay carpetas duplicadas llamadas ${name} en Google Drive.`
      : `No se encontró la carpeta ${name} en Google Drive.`);
  }
  return data.files[0];
}

async function listFolderFiles(drive, folderId) {
  const files = [];
  let pageToken;
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      spaces: 'drive',
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken,files(id,name,mimeType,trashed)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

function getMappedLogoReference(brandName) {
  const expectedBrand = normalizeBrand(brandName);
  return Object.entries(BRAND_LOGO_PATHS)
    .find(([configuredBrand]) => normalizeBrand(configuredBrand) === expectedBrand)?.[1];
}

function getDriveFileId(driveUrl, brandName) {
  let logoUrl;
  try {
    logoUrl = new URL(driveUrl);
  } catch (error) {
    throw new RepDriveStorageError(`La URL configurada para la marca ${brandName} no es válida.`, error);
  }
  const fileId = logoUrl.searchParams.get('id')
    || logoUrl.pathname.match(/\/file\/d\/([^/]+)/)?.[1];
  if (logoUrl.protocol !== 'https:' || logoUrl.hostname !== 'drive.google.com' || !fileId) {
    throw new RepDriveStorageError(`La URL configurada para la marca ${brandName} debe ser un enlace válido de Google Drive.`);
  }
  return fileId;
}

async function resolveConfiguredLogo(drive, rootFolderId, relativePath, brandName) {
  if (/^https?:\/\//i.test(relativePath)) {
    const fileId = getDriveFileId(relativePath, brandName);
    const { data: file } = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,trashed',
      supportsAllDrives: true,
    });
    console.info('[REP Drive] Archivo configurado de Google Drive', {
      brand: brandName,
      fileId,
      file: file ? { id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed } : null,
    });
    if (!file?.id || file.trashed || !IMAGE_MIME_TYPES.has(file.mimeType)) {
      throw new RepDriveStorageError(`El enlace configurado para ${brandName} no apunta a una imagen disponible en Google Drive.`);
    }
    return file;
  }
  if (typeof relativePath !== 'string' || !relativePath.trim()
    || relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new RepDriveStorageError(`La ruta configurada para la marca ${brandName} debe ser relativa a la carpeta raíz de Drive.`);
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new RepDriveStorageError(`La ruta configurada para la marca ${brandName} no es válida.`);
  }
  const fileName = segments.pop();
  let folderId = rootFolderId;
  for (const folderName of segments) {
    folderId = (await findUniqueFolder(drive, folderId, folderName)).id;
  }
  const files = await listFolderFiles(drive, folderId);
  logConsoleEvent('rep_logo_files_found', {
    brand: brandName,
    configuredPath: relativePath,
    folderId,
    fileCount: files.length,
    files: files.map(({ id, name, mimeType, trashed }) => ({ id, name, mimeType, trashed })),
  });
  console.info('[REP Drive] Archivos encontrados en la ruta configurada', {
    brand: brandName,
    configuredPath: relativePath,
    folderId,
    fileCount: files.length,
    files: files.map(({ id, name, mimeType, trashed }) => ({ id, name, mimeType, trashed })),
  });
  const matches = files.filter((file) => file.name === fileName && IMAGE_MIME_TYPES.has(file.mimeType));
  if (matches.length !== 1) {
    throw new RepDriveStorageError(matches.length
      ? `Hay archivos duplicados para la ruta configurada del logotipo ${relativePath}.`
      : `No se encontró la imagen ${relativePath} configurada para la marca ${brandName}.`);
  }
  return matches[0];
}

async function resolveBrandLogo(drive, brandName, brandLogoPaths = BRAND_LOGO_PATHS) {
  const rootFolderId = getGoogleDriveOAuthConfig().rootFolderId;
  if (!rootFolderId) throw new RepDriveStorageError('Falta configurar la carpeta raíz de Google Drive.');
  if (!brandName) throw new RepDriveStorageError('La agencia no tiene una marca configurada para resolver el logo.');
  const expectedBrand = normalizeBrand(brandName);
  const configuredPath = Object.entries(brandLogoPaths)
    .find(([configuredBrand]) => normalizeBrand(configuredBrand) === expectedBrand)?.[1];
  if (configuredPath) {
    logConsoleEvent('rep_logo_mapping_used', { brand: brandName, normalizedBrand: expectedBrand, configuredPath });
    console.info('[REP Drive] Mapeo de logotipo seleccionado', {
      brand: brandName,
      normalizedBrand: expectedBrand,
      configuredPath,
    });
    return resolveConfiguredLogo(drive, rootFolderId, configuredPath, brandName);
  }
  const resources = await findUniqueFolder(drive, rootFolderId, 'Recursos');
  const logos = await findUniqueFolder(drive, resources.id, 'Logotipos');
  const files = await listFolderFiles(drive, logos.id);
  logConsoleEvent('rep_logo_files_found', {
    brand: brandName,
    normalizedBrand: expectedBrand,
    folderId: logos.id,
    fileCount: files.length,
    files: files.map(({ id, name, mimeType, trashed }) => ({ id, name, mimeType, trashed })),
  });
  console.info('[REP Drive] Todos los archivos encontrados en Recursos/Logotipos', {
    brand: brandName,
    normalizedBrand: expectedBrand,
    folderId: logos.id,
    fileCount: files.length,
    files: files.map(({ id, name, mimeType, trashed }) => ({ id, name, mimeType, trashed })),
  });
  const matches = files.filter((file) => (
    IMAGE_MIME_TYPES.has(file.mimeType)
    && normalizeBrand(file.name.replace(/\.[^.]+$/, '')) === expectedBrand
  ));
  logConsoleEvent('rep_logo_matches', {
    brand: brandName,
    normalizedBrand: expectedBrand,
    matches: matches.map(({ id, name, mimeType }) => ({ id, name, mimeType })),
  });
  console.info('[REP Drive] Archivos de logotipo coincidentes', {
    brand: brandName,
    normalizedBrand: expectedBrand,
    matches: matches.map(({ id, name, mimeType }) => ({ id, name, mimeType })),
  });
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

async function fetchPublicGoogleDriveLogo(driveUrl, brandName) {
  const fileId = getDriveFileId(driveUrl, brandName);
  const downloadUrl = new URL('https://drive.google.com/uc');
  downloadUrl.searchParams.set('export', 'download');
  downloadUrl.searchParams.set('id', fileId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    console.info('[REP Drive] Intentando descarga pública del logotipo', { brand: brandName, fileId });
    const response = await fetch(downloadUrl, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      throw new RepDriveStorageError(`Google Drive no permite descargar el logotipo de ${brandName} mediante el enlace público (HTTP ${response.status}).`);
    }
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
      throw new RepDriveStorageError(`El enlace público de ${brandName} no devolvió una imagen; revisa que Drive permita verla a cualquier persona con el enlace.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new RepDriveStorageError(`Google Drive devolvió una respuesta vacía para el logotipo de ${brandName}.`);
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PUBLIC_LOGO_BYTES) {
        await reader.cancel();
        throw new RepDriveStorageError(`El logotipo de ${brandName} supera el límite de 5 MiB.`);
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new RepDriveStorageError(`Google Drive devolvió un logotipo vacío para ${brandName}.`);
    console.info('[REP Drive] Logotipo descargado por enlace público', { brand: brandName, fileId, mimeType, bytes: buffer.length });
    return { buffer, mimeType };
  } finally {
    clearTimeout(timeout);
  }
}

async function getBrandLogo(drive, brandName) {
  try {
    const file = await resolveBrandLogo(drive, brandName);
    const response = await drive.files.get(
      { fileId: file.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    return {
      buffer: await readDriveStream(response.data),
      mimeType: file.mimeType,
    };
  } catch (error) {
    const status = Number(error?.response?.status || error?.cause?.response?.status || error?.code);
    const logoReference = getMappedLogoReference(brandName);
    if (![403, 404].includes(status) || typeof logoReference !== 'string' || !/^https:\/\//i.test(logoReference)) {
      throw error;
    }
    console.warn('[REP Drive] La API OAuth no pudo leer el logo; se probará el enlace público', {
      brand: brandName,
      status,
      message: error.message,
    });
    return fetchPublicGoogleDriveLogo(logoReference, brandName);
  }
}

async function ensureRepFolder(drive, report) {
  const rootFolderId = getGoogleDriveOAuthConfig().rootFolderId;
  if (!rootFolderId) throw new RepDriveStorageError('Falta configurar la carpeta raíz de Google Drive.');
  const inspectionDate = report.generalData?.inspectionDate || '';
  const period = /^\d{4}-\d{2}-\d{2}$/.test(inspectionDate) ? inspectionDate.slice(0, 7) : '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new RepDriveStorageError('El período del reporte no es válido para crear su carpeta en Drive.');
  }
  const brand = String(report.agencyBrandSnapshot || '').trim();
  if (!brand) throw new RepDriveStorageError('La agencia no tiene una marca configurada.');
  let parentId = rootFolderId;
  for (const name of ['Servicios EF', 'Recorridos Medio Ambiente', period.slice(0, 4), period.slice(5, 7), brand]) {
    parentId = (await findOrCreateFolder(drive, parentId, name)).id;
  }
  return parentId;
}

async function ensureRepImageFolder(drive, report) {
  if (report.drive?.evidenceFolderId) return report.drive.evidenceFolderId;
  const rootFolderId = getGoogleDriveOAuthConfig().rootFolderId;
  if (!rootFolderId) throw new RepDriveStorageError('Falta configurar la carpeta raíz de Google Drive.');
  const inspectionDate = report.generalData?.inspectionDate || '';
  const period = /^\d{4}-\d{2}-\d{2}$/.test(inspectionDate) ? inspectionDate.slice(0, 7) : '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new RepDriveStorageError('El período del reporte no es válido para crear su carpeta en Drive.');
  }
  const agencyName = String(report.agencyNameSnapshot || 'Agencia')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'Agencia';
  let parentId = rootFolderId;
  for (const name of ['Evidencias', period.slice(0, 4), period.slice(5, 7), agencyName, 'REP', report.reportId]) {
    parentId = (await findOrCreateFolder(drive, parentId, name)).id;
  }
  report.drive = { ...report.drive, evidenceFolderId: parentId };
  await report.save();
  return parentId;
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
  const existing = await findDriveFileByAppProperties(drive, null, appProperties);
  if (existing) {
    const parents = existing.parents || [];
    if (!parents.includes(folderId)) {
      const request = {
        fileId: existing.id,
        addParents: folderId,
        supportsAllDrives: true,
        requestBody: { name: `${imageId}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length)}` },
        fields: 'id,name,mimeType,parents,size,md5Checksum,appProperties',
      };
      if (parents.length) request.removeParents = parents.join(',');
      const { data } = await drive.files.update(request);
      return data;
    }
    return existing;
  }
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
  listFolderFiles,
  uploadRepExcelToDrive,
  uploadRepImageToDrive,
};
