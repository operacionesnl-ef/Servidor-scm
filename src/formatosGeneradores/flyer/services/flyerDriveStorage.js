'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { getGoogleDriveOAuthConfig } = require('../../../config/googleDrive');
const {
  findDriveFileByAppProperties,
  findOrCreateFolder,
  retryTransientGoogleDriveOperation,
  uploadDriveFile,
} = require('../../../services/googleDriveService');

const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PNG_MIME_TYPE = 'image/png';
const FLYER_FOLDER_NAME = 'flyer';
const FLYER_BACKGROUND_FOLDER_NAME = 'imagenes-fondo';
const TIME_ZONE = 'America/Monterrey';
const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024;

function getCourseDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('La fecha del curso no es válida para guardarla en Drive.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(({ type, value: partValue }) => [type, partValue]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sanitizeCourseName(value) {
  const name = String(value || '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  if (!name) throw new Error('El curso necesita un nombre válido para crear los archivos de Drive.');
  return name;
}

async function ensureFlyerFolder(drive) {
  const { rootFolderId } = getGoogleDriveOAuthConfig();
  if (!rootFolderId) throw new Error('Falta configurar la carpeta raíz de Google Drive.');
  const folder = await retryTransientGoogleDriveOperation(
    () => findOrCreateFolder(drive, rootFolderId, FLYER_FOLDER_NAME),
  );
  return folder.id;
}

async function ensureFlyerBackgroundFolder(drive) {
  const flyerFolderId = await ensureFlyerFolder(drive);
  const folder = await retryTransientGoogleDriveOperation(
    () => findOrCreateFolder(drive, flyerFolderId, FLYER_BACKGROUND_FOLDER_NAME),
  );
  return folder.id;
}

async function upsertFlyerFile(drive, {
  folderId,
  formId,
  date,
  format,
  fileName,
  mimeType,
  buffer,
}) {
  if (!folderId || !formId || !date || !fileName || !mimeType || !Buffer.isBuffer(buffer) || !buffer.length) {
    throw new TypeError('Se requieren curso, carpeta, formato, nombre y contenido para guardar el flyer.');
  }
  const appProperties = {
    efcoreGeneratedFlyer: 'true',
    efcoreFormularioId: String(formId),
    efcoreFlyerDate: date,
    efcoreFlyerFormat: format,
  };
  const existing = await retryTransientGoogleDriveOperation(
    () => findDriveFileByAppProperties(drive, folderId, appProperties),
  );

  let file;
  if (existing) {
    const parents = existing.parents || [];
    const request = {
      fileId: existing.id,
      supportsAllDrives: true,
      requestBody: { name: fileName, appProperties },
      media: { mimeType, body: Readable.from([buffer]) },
      fields: 'id,name,mimeType,parents,webViewLink,appProperties',
    };
    if (!parents.includes(folderId)) {
      request.addParents = folderId;
      if (parents.length) request.removeParents = parents.join(',');
    }
    const { data } = await retryTransientGoogleDriveOperation(() => drive.files.update(request));
    file = data;
  } else {
    file = await retryTransientGoogleDriveOperation(() => uploadDriveFile(drive, {
      folderId,
      fileName,
      mimeType,
      body: Readable.from([buffer]),
      appProperties,
    }));
  }

  return {
    driveFileId: file.id,
    fileName: file.name || fileName,
    mimeType,
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
  };
}

async function readDriveStream(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BACKGROUND_BYTES) {
      stream.destroy();
      throw new Error('El fondo guardado en Drive supera el tamaño permitido.');
    }
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error('El fondo guardado en Drive está vacío.');
  return buffer;
}

function isFormularioFlyerBackground(file, formId) {
  return file.mimeType === 'image/jpeg'
    && file.appProperties?.efcoreGeneratedFlyer === 'true'
    && file.appProperties?.efcoreFormularioId === String(formId)
    && file.appProperties?.efcoreFlyerFormat === 'background';
}

async function listFormularioFlyerBackgrounds(drive, formId) {
  if (!formId) throw new TypeError('Se requiere el formulario para listar sus fondos.');
  const folderId = await ensureFlyerBackgroundFolder(drive);
  const files = [];
  let pageToken;
  do {
    const { data } = await retryTransientGoogleDriveOperation(() => drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      spaces: 'drive',
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken,files(id,name,mimeType,parents,size,createdTime,appProperties)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }));
    files.push(...(data.files || []).filter((file) => isFormularioFlyerBackground(file, formId)));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return {
    folderId,
    backgrounds: files
      .sort((left, right) => String(right.createdTime || '').localeCompare(String(left.createdTime || '')))
      .map((file) => ({
        driveFileId: file.id,
        fileName: file.name,
        createdTime: file.createdTime || null,
        size: Number(file.size) || 0,
      })),
  };
}

async function getFormularioFlyerBackgroundFile(drive, formId, fileId) {
  if (!formId || !fileId) throw new TypeError('Se requieren formulario e imagen para recuperar el fondo.');
  const folderId = await ensureFlyerBackgroundFolder(drive);
  const { data: file } = await retryTransientGoogleDriveOperation(() => drive.files.get({
    fileId,
    fields: 'id,name,mimeType,parents,size,createdTime,appProperties',
    supportsAllDrives: true,
  }));
  if (!file || !isFormularioFlyerBackground(file, formId) || !file.parents?.includes(folderId)) return null;
  if (Number(file.size) > MAX_BACKGROUND_BYTES) throw new Error('El fondo guardado en Drive supera el tamaño permitido.');

  const response = await retryTransientGoogleDriveOperation(() => drive.files.get({
    fileId,
    alt: 'media',
    supportsAllDrives: true,
  }, { responseType: 'stream' }));
  const buffer = await readDriveStream(response.data);
  if (!buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    throw new Error('El fondo guardado en Drive está dañado; regenera la imagen.');
  }
  return { ...file, buffer };
}

async function uploadFormularioFlyerBackground(drive, { folderId, form, date, buffer }) {
  const version = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const fileName = `${sanitizeCourseName(form.tituloCurso || form.nombreCurso)}-${date}-fondo-${version}.jpg`;
  const appProperties = {
    efcoreGeneratedFlyer: 'true',
    efcoreFormularioId: String(form._id),
    efcoreFlyerDate: date,
    efcoreFlyerFormat: 'background',
    efcoreFlyerVersion: version,
  };
  return retryTransientGoogleDriveOperation(() => uploadDriveFile(drive, {
    folderId,
    fileName,
    mimeType: 'image/jpeg',
    body: Readable.from([buffer]),
    appProperties,
  }));
}

async function getOrCreateFormularioFlyerBackground(drive, {
  form,
  force = false,
  generate,
}) {
  if (typeof generate !== 'function') throw new TypeError('Se requiere un generador de fondo.');
  if (!form?._id) throw new TypeError('Se requiere un formulario guardado para generar el fondo.');
  const courseName = form.tituloCurso || form.nombreCurso;
  if (!courseName || !String(form.norma || '').trim()) {
    throw new Error('El formulario debe incluir nombre del curso y norma.');
  }
  const date = getCourseDate(form.configuracionFechas?.fechaCurso);
  const folderId = await ensureFlyerBackgroundFolder(drive);
  if (!force) {
    const fileId = form.flyerBackgroundDriveId
      || (await listFormularioFlyerBackgrounds(drive, form._id)).backgrounds[0]?.driveFileId;
    if (fileId) {
      const cached = await getFormularioFlyerBackgroundFile(drive, form._id, fileId);
      if (cached) return { buffer: cached.buffer, cacheHit: true, driveFileId: cached.id };
    }
  }

  const buffer = await generate();
  if (!Buffer.isBuffer(buffer) || buffer.length < 2
    || !buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))
    || buffer.length > MAX_BACKGROUND_BYTES) {
    throw new Error('El generador no devolvió un JPEG válido para el fondo del flyer.');
  }
  const file = await uploadFormularioFlyerBackground(drive, { folderId, form, date, buffer });
  return { buffer, cacheHit: false, driveFileId: file.id, fileName: file.name };
}

async function saveFormularioFlyerFiles(drive, { form, pptxBuffer, imageBuffer }) {
  const courseName = form?.tituloCurso || form?.nombreCurso;
  if (!form?._id || !courseName) throw new TypeError('Se requiere un formulario guardado para almacenar el flyer.');
  const date = getCourseDate(form.configuracionFechas?.fechaCurso);
  const fileBase = `${sanitizeCourseName(courseName)}-${date}`;
  const folderId = await ensureFlyerFolder(drive);
  const pptx = await upsertFlyerFile(drive, {
    folderId,
    formId: form._id,
    date,
    format: 'pptx',
    fileName: `${fileBase}.pptx`,
    mimeType: PPTX_MIME_TYPE,
    buffer: pptxBuffer,
  });
  const image = await upsertFlyerFile(drive, {
    folderId,
    formId: form._id,
    date,
    format: 'png',
    fileName: `${fileBase}.png`,
    mimeType: PNG_MIME_TYPE,
    buffer: imageBuffer,
  });
  return { folderId, folderName: FLYER_FOLDER_NAME, files: { pptx, image } };
}

module.exports = {
  FLYER_BACKGROUND_FOLDER_NAME,
  FLYER_FOLDER_NAME,
  ensureFlyerFolder,
  ensureFlyerBackgroundFolder,
  getFormularioFlyerBackgroundFile,
  getOrCreateFormularioFlyerBackground,
  getCourseDate,
  listFormularioFlyerBackgrounds,
  sanitizeCourseName,
  saveFormularioFlyerFiles,
};
