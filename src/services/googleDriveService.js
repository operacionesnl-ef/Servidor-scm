'use strict';

const { createGoogleDriveClient, getGoogleDriveOAuthConfig } = require('../config/googleDrive');

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateRootFolder(drive, folderName) {
  const { data } = await drive.files.list({
    q: `name = '${escapeDriveQuery(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    spaces: 'drive',
    pageSize: 10,
    fields: 'files(id,name,mimeType)',
  });
  const existingFolder = data.files?.[0];
  if (existingFolder) return existingFolder;

  const { data: createdFolder } = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id,name,mimeType',
  });
  return createdFolder;
}

async function findOrCreateFolder(drive, parentId, folderName) {
  if (!parentId || !folderName) throw new TypeError('Se requieren carpeta principal y nombre de carpeta.');
  const { data } = await drive.files.list({
    q: `'${escapeDriveQuery(parentId)}' in parents and name = '${escapeDriveQuery(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    spaces: 'drive',
    pageSize: 10,
    fields: 'files(id,name,mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (data.files?.length > 1) {
    throw new Error(`Se encontraron carpetas duplicadas con el nombre ${folderName}.`);
  }
  if (data.files?.[0]) return data.files[0];

  const { data: createdFolder } = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id,name,mimeType',
    supportsAllDrives: true,
  });
  return createdFolder;
}

async function findOrCreateAuxiliaryFolder(drive) {
  const { rootFolderId } = getGoogleDriveOAuthConfig();
  if (!rootFolderId) throw new Error('Falta configurar GOOGLE_DRIVE_ROOT_FOLDER_ID para crear copias auxiliares.');
  return findOrCreateFolder(drive, rootFolderId, 'Copias_auxiliares');
}

async function createOrGetPublicDriveCopy(drive, { sourceDriveId, folderId, fileName }) {
  if (!sourceDriveId || !folderId || !fileName) {
    throw new TypeError('Se requieren archivo original, carpeta auxiliar y nombre para crear una copia.');
  }

  const existingCopy = await findDriveFileByAppProperties(drive, folderId, { scmOriginalDriveId: sourceDriveId });
  let copy = existingCopy;
  if (!copy) {
    const { data } = await drive.files.copy({
      fileId: sourceDriveId,
      supportsAllDrives: true,
      requestBody: {
        name: fileName,
        parents: [folderId],
        appProperties: { scmOriginalDriveId: sourceDriveId },
      },
      fields: 'id,name,mimeType,webViewLink,size,parents,appProperties',
    });
    copy = data;
  }

  if (!copy.webViewLink) {
    const { data } = await drive.files.get({
      fileId: copy.id,
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });
    copy = { ...copy, ...data };
  }
  if (!copy.webViewLink) throw new Error(`Drive no devolvió un enlace para la copia de ${fileName}.`);

  const { data: permissionData } = await drive.permissions.list({
    fileId: copy.id,
    fields: 'permissions(id,type,role)',
    supportsAllDrives: true,
  });
  const publicPermission = (permissionData.permissions || []).find((permission) => permission.type === 'anyone');
  if (publicPermission?.role !== 'reader') {
    if (publicPermission) {
      await drive.permissions.update({
        fileId: copy.id,
        permissionId: publicPermission.id,
        requestBody: { role: 'reader', allowFileDiscovery: false },
        supportsAllDrives: true,
      });
    } else {
      await drive.permissions.create({
        fileId: copy.id,
        requestBody: { type: 'anyone', role: 'reader', allowFileDiscovery: false },
        fields: 'id,type,role',
        supportsAllDrives: true,
      });
    }
  }
  return copy;
}

async function findDriveFileByAppProperties(drive, folderId, appProperties) {
  const propertyQuery = Object.entries(appProperties)
    .map(([key, value]) => `appProperties has { key='${escapeDriveQuery(key)}' and value='${escapeDriveQuery(value)}' }`)
    .join(' and ');
  const { data } = await drive.files.list({
    q: `'${escapeDriveQuery(folderId)}' in parents and ${propertyQuery} and trashed = false`,
    spaces: 'drive',
    pageSize: 10,
    fields: 'files(id,name,mimeType,parents,size,md5Checksum,appProperties)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (data.files?.length > 1) {
    throw new Error('Drive contiene más de un archivo con la misma identidad de evidencia.');
  }
  return data.files?.[0] || null;
}

async function getRootFolderStatus() {
  const config = getGoogleDriveOAuthConfig();
  if (!config.refreshToken || !config.rootFolderId) {
    return {
      configured: false,
      message: 'Configura el refresh token y el ID de la carpeta raíz en el entorno del backend.',
    };
  }

  const drive = createGoogleDriveClient(config);
  const { data } = await drive.files.get({
    fileId: config.rootFolderId,
    fields: 'id,name,mimeType,trashed',
  });
  return {
    configured: true,
    accessible: data.mimeType === 'application/vnd.google-apps.folder' && !data.trashed,
    folder: { id: data.id, name: data.name },
  };
}

async function uploadDriveFile(drive, { folderId, fileName, mimeType, body, appProperties }) {
  if (!folderId || !fileName || !mimeType || !body) {
    throw new TypeError('Se requieren carpeta, nombre, tipo MIME y contenido para subir un archivo.');
  }
  const { data } = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      ...(appProperties ? { appProperties } : {}),
    },
    media: { mimeType, body },
    fields: 'id,name,mimeType,parents,size,md5Checksum',
  });
  return data;
}

async function getDriveFileMetadata(drive, fileId) {
  if (!fileId) throw new TypeError('Se requiere el ID del archivo de Drive.');
  const { data } = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,parents,size,md5Checksum,trashed',
  });
  return data;
}

async function deleteDriveFile(drive, fileId) {
  if (!fileId) throw new TypeError('Se requiere el ID del archivo de Drive.');
  await drive.files.delete({ fileId });
}

module.exports = {
  deleteDriveFile,
  createOrGetPublicDriveCopy,
  findDriveFileByAppProperties,
  findOrCreateFolder,
  findOrCreateAuxiliaryFolder,
  findOrCreateRootFolder,
  getDriveFileMetadata,
  getRootFolderStatus,
  uploadDriveFile,
};
