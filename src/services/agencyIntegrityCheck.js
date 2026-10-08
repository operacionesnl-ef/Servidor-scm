'use strict';

const { FILE_TYPES, identifyFileType, getFilePeriod } = require('../utils/agencyFileRefreshUtils');

async function getDriveFolderPath(drive, file) {
  const folderPath = [];
  const visited = new Set();
  let parentId = file.parents?.[0];

  while (parentId && !visited.has(parentId) && folderPath.length < 32) {
    visited.add(parentId);
    const response = await drive.files.get({
      fileId: parentId,
      fields: 'id,name,mimeType,parents',
      supportsAllDrives: true,
    });
    const folder = response.data;
    if (folder.mimeType !== 'application/vnd.google-apps.folder') break;
    folderPath.unshift(folder.name);
    parentId = folder.parents?.[0];
  }

  return folderPath;
}

function storedFilePeriod(file) {
  if (Number.isInteger(file.periodYear) && Number.isInteger(file.periodMonth)) {
    return { year: file.periodYear, month: file.periodMonth };
  }
  return getFilePeriod({
    name: file.nombre,
    folderPath: file.pseudoPath || [],
    path: file.path || '',
  });
}

async function inspectFile(drive, agency, fileType) {
  const file = agency.archivos?.[fileType.key];
  const problems = [];
  if (!file?.nombre || !file?.driveId || !file?.ruta) {
    return {
      key: fileType.key,
      code: fileType.code,
      fileId: file?.driveId || '',
      status: 'error',
      fileName: file?.nombre || '',
      path: file?.path || '',
      sizeBytes: null,
      modifiedTime: null,
      period: null,
      problems: ['Faltan datos de archivo, ruta o ID de Drive.'],
    };
  }

  let metadata;
  try {
    const response = await drive.files.get({
      fileId: file.driveId,
      fields: 'id,name,mimeType,size,modifiedTime,webViewLink,parents',
      supportsAllDrives: true,
    });
    metadata = response.data;
  } catch (error) {
    const statusCode = Number(error.code || error.response?.status);
    if (statusCode === 401) throw error;
    const reason = statusCode === 404
      ? 'El archivo no existe en Drive o fue eliminado.'
      : statusCode === 403
        ? 'La cuenta autorizada no tiene acceso al archivo.'
        : error.message || 'No se pudo comprobar el archivo en Drive.';
    return {
      key: fileType.key,
      code: fileType.code,
      fileId: file.driveId,
      status: 'error',
      fileName: file.nombre,
      path: file.path || '',
      sizeBytes: null,
      modifiedTime: null,
      period: storedFilePeriod(file),
      problems: [reason],
    };
  }

  const actualType = identifyFileType({ name: metadata.name });
  if (actualType?.key !== fileType.key) {
    problems.push(`El nombre no confirma la marca ${fileType.code}.`);
  }

  let folderPath;
  let folderPathError = '';
  try {
    folderPath = metadata.parents === undefined
      ? (file.pseudoPath || [])
      : await getDriveFolderPath(drive, metadata);
  } catch (error) {
    folderPathError = error.message || 'No se pudo leer la ruta de carpetas en Drive.';
  }
  const period = folderPathError
    ? null
    : getFilePeriod({ name: metadata.name, folderPath: folderPath || [] });
  const expectedPeriod = storedFilePeriod(file);
  if (folderPathError) {
    problems.push(`No se pudo comprobar el período de las carpetas: ${folderPathError}`);
  }
  if (!period) {
    problems.push('No se pudo identificar el período de las carpetas.');
  } else if (
    expectedPeriod &&
    (period.year !== expectedPeriod.year || period.month !== expectedPeriod.month)
  ) {
    problems.push('El período actual del archivo no coincide con el período guardado.');
  }

  const sizeBytes = metadata.size === undefined ? null : Number(metadata.size);
  if (sizeBytes === 0) problems.push('Drive reporta que el archivo está vacío.');
  return {
    key: fileType.key,
    code: fileType.code,
    fileId: file.driveId,
    status: problems.length ? 'warning' : 'ok',
    fileName: metadata.name,
    path: folderPath?.length
      ? [...folderPath, metadata.name].filter(Boolean).join('/')
      : file.path || metadata.name,
    mimeType: metadata.mimeType || '',
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    modifiedTime: metadata.modifiedTime || null,
    period,
    expectedPeriod,
    webViewLink: metadata.webViewLink || '',
    problems,
  };
}

async function inspectAgencyIntegrity(drive, agency, expectedPeriod) {
  const checks = [];
  for (const fileType of FILE_TYPES) {
    const check = await inspectFile(drive, agency, fileType);
    if (
      expectedPeriod &&
      check.period &&
      (check.period.year !== expectedPeriod.year || check.period.month !== expectedPeriod.month)
    ) {
      check.problems.push('La fecha del archivo no coincide con el período seleccionado.');
      if (check.status === 'ok') check.status = 'warning';
    }
    checks.push(check);
  }

  const actualPeriods = new Set(
    checks.filter((check) => check.period)
      .map((check) => `${check.period.year}-${check.period.month}`)
  );
  if (actualPeriods.size > 1) {
    checks.forEach((check) => {
      if (check.period) {
        check.problems.push('El período no coincide con los otros archivos de la agencia.');
        if (check.status === 'ok') check.status = 'warning';
      }
    });
  }

  const issues = checks.filter((check) => check.status !== 'ok').length;
  return {
    checks,
    status: issues ? 'issues' : 'updated',
    missingKeys: checks.filter((check) => check.status === 'error').map((check) => check.key),
  };
}

module.exports = { inspectAgencyIntegrity };
