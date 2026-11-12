'use strict';

const { Readable } = require('node:stream');
const { getGoogleDriveOAuthConfig } = require('../../../config/googleDrive');
const BRAND_LOGO_PATHS = require('../../../config/repBrandLogoPaths');
const { findDriveFileByAppProperties, findOrCreateFolder, uploadDriveFile } = require('../../../services/googleDriveService');
const { getBrandLogo: getRepBrandLogo } = require('../../rep/services/repDriveStorage');
const { logConsoleEvent } = require('../../../utils/serverLogger');
const { MONTH_NAMES_ES } = require('../../../utils/drivePatternUtils');

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILE_PROPERTIES = { efcoreGeneratedExcel: 'REV-EXT' };

function normalizeBrand(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function getBrandLogo(drive, brandName) {
  const expectedBrand = normalizeBrand(brandName);
  const configuredBrand = Object.keys(BRAND_LOGO_PATHS)
    .find((brand) => normalizeBrand(brand) === expectedBrand);
  if (configuredBrand) return getRepBrandLogo(drive, configuredBrand);

  const fallbackBrand = 'CLEBER';
  if (!BRAND_LOGO_PATHS[fallbackBrand]) {
    throw new Error('No hay un logotipo de respaldo configurado para REV.');
  }
  logConsoleEvent('rev_brand_logo_fallback', {
    brand: String(brandName || ''),
    fallbackBrand,
  });
  return getRepBrandLogo(drive, fallbackBrand);
}

async function ensureRevFolder(drive, report) {
  const { rootFolderId } = getGoogleDriveOAuthConfig();
  if (!rootFolderId) throw new Error('Falta configurar la carpeta raíz de Google Drive.');
  const date = report.generalData?.inspectionDate || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('La fecha de inspección REV no es válida para crear la carpeta de Drive.');
  const brand = String(report.agencyBrandSnapshot || '').trim();
  if (!brand) throw new Error('La agencia no tiene una marca configurada.');
  const monthName = MONTH_NAMES_ES[Number(date.slice(5, 7)) - 1];
  let parentId = rootFolderId;
  for (const name of ['Servicios EF', 'Recorrido de extintores', date.slice(0, 4), monthName, brand]) {
    parentId = (await findOrCreateFolder(drive, parentId, name)).id;
  }
  return parentId;
}

async function uploadRevExcelToDrive(drive, { folderId, reportId, revision, fileName, buffer }) {
  if (!folderId || !reportId || !Number.isInteger(revision) || !fileName || !Buffer.isBuffer(buffer) || !buffer.length) {
    throw new TypeError('Se requieren reporte, revisión, carpeta, nombre y contenido para guardar el Excel REV.');
  }
  const appProperties = {
    ...FILE_PROPERTIES,
    efcoreGeneratedReportId: reportId,
    efcoreGeneratedRevision: String(revision),
  };
  const existing = await findDriveFileByAppProperties(drive, null, {
    ...FILE_PROPERTIES,
    efcoreGeneratedReportId: reportId,
  });
  if (existing) {
    const parents = existing.parents || [];
    const { data } = await drive.files.update({
      fileId: existing.id,
      supportsAllDrives: true,
      requestBody: { name: fileName, appProperties },
      media: { mimeType: XLSX_MIME_TYPE, body: Readable.from([buffer]) },
      fields: 'id,name,parents,appProperties',
    });
    if (!parents.includes(folderId)) {
      const { data: moved } = await drive.files.update({
        fileId: existing.id,
        addParents: folderId,
        ...(parents.length ? { removeParents: parents.join(',') } : {}),
        supportsAllDrives: true,
        fields: 'id,name',
      });
      return { driveFileId: moved.id, folderId, fileName: moved.name || fileName };
    }
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

module.exports = { ensureRevFolder, getBrandLogo, uploadRevExcelToDrive };
