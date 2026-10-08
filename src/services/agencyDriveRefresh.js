'use strict';

const { FILE_TYPES, selectRefreshFiles } = require('../utils/agencyFileRefreshUtils');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_DESCENDANTS = 5000;
const MAX_DEPTH = 8;
const quoteDriveQueryValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function listDescendants(drive, rootFolderId) {
  const descendants = [];
  const queue = [{ id: rootFolderId, depth: 0, folderPath: [] }];
  const visited = new Set([rootFolderId]);

  while (queue.length && descendants.length < MAX_DESCENDANTS) {
    const current = queue.shift();
    if (current.depth >= MAX_DEPTH) continue;

    let pageToken;
    do {
      const { data } = await drive.files.list({
        q: `'${quoteDriveQueryValue(current.id)}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
        ...(pageToken ? { pageToken } : {}),
      });

      for (const child of data.files || []) {
        descendants.push({
          ...child,
          folderPath: current.folderPath,
          path: [...current.folderPath, child.name].filter(Boolean).join('/'),
        });
        if (child.mimeType === FOLDER_MIME && !visited.has(child.id)) {
          visited.add(child.id);
          queue.push({
            id: child.id,
            depth: current.depth + 1,
            folderPath: [...current.folderPath, child.name],
          });
        }
        if (descendants.length >= MAX_DESCENDANTS) break;
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken && descendants.length < MAX_DESCENDANTS);
  }

  return descendants;
}

function buildAgencyRefresh(agency, descendants, year, month) {
  const selected = selectRefreshFiles(descendants, year, month);
  const results = {};
  const currentFiles = agency.archivos?.toObject?.() || agency.archivos || {};
  const archivos = {
    carpetaPrincipal: currentFiles.carpetaPrincipal,
    carpetaBase: currentFiles.carpetaBase,
  };

  for (const { key } of FILE_TYPES) {
    const match = selected[key];
    if (!match) {
      archivos[key] = null;
      results[key] = { status: 'missing' };
      continue;
    }

    const file = match.file;
    const folderPath = Array.isArray(file.folderPath)
      ? file.folderPath
      : String(file.path || '').split(/[\\/]/).map((part) => part.trim()).filter(Boolean).slice(0, -1);
    const persistedFile = {
      nombre: file.name.trim(),
      ruta: file.parents?.[0] || file.id,
      driveId: file.id,
      pseudoPath: folderPath,
      path: typeof file.path === 'string' && file.path.trim()
        ? file.path.trim()
        : [...folderPath, file.name.trim()].join(' / '),
      periodYear: match.period.year,
      periodMonth: match.period.month,
    };

    archivos[key] = persistedFile;
    results[key] = {
      status: 'found',
      file: persistedFile,
      periodYear: match.period.year,
      periodMonth: match.period.month,
    };
  }

  return {
    archivos,
    results,
    scannedFiles: descendants.length,
    summary: {
      found: FILE_TYPES.filter(({ key }) => results[key].status === 'found').length,
      missing: FILE_TYPES.filter(({ key }) => results[key].status === 'missing').length,
      year,
      month,
    },
  };
}

async function refreshAgencyFromDrive(agency, drive, year, month, folderId) {
  const rootFolderId = folderId || agency.archivos?.carpetaPrincipal;
  if (!rootFolderId) {
    const error = new Error('Esta agencia no tiene una carpeta de Drive principal configurada.');
    error.missingRoot = true;
    throw error;
  }

  const descendants = await listDescendants(drive, rootFolderId);
  const update = buildAgencyRefresh(agency, descendants, year, month);
  agency.set('archivos', update.archivos);
  await agency.save();
  return update;
}

module.exports = { listDescendants, buildAgencyRefresh, refreshAgencyFromDrive };
