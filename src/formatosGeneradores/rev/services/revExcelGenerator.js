'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const pathPosix = path.posix;
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');

const TEMPLATE_VERSION = '1.2';
const DEFAULT_TEMPLATE_PATH = path.join(__dirname, '../templates/REV-EXT.xlsx');
const SHEETS = { cover: 'CARATULA', inspection: 'INSPECCIÓN' };
const CHECK_MARKERS = new Set([
  'pintura', 'golpes', 'adhesivo', 'transporte', 'disparo', 'presion', 'manometro',
  'manguera', 'ring', 'boquilla', 'señalizacion', 'libre', 'limpio',
]);
const ROW_MARKERS = [
  'n', 'pqs', 'co2', 'agua', 'tipod', 'tipok', 'capacidad', 'pintura',
  'golpes', 'adhesivo', 'transporte', 'disparo', 'presion', 'manometro',
  'manguera', 'ring', 'boquilla', 'señalizacion', 'libre', 'limpio',
  'fecha_carga', 'fecha_vencimiento', 'status', 'observaciones', 'ubicacion',
];

class RevExcelError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'RevExcelError';
  }
}

function formatDate(value) {
  if (!value) return '';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function getCheckFontColor(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  if (normalized === '1') return 'FF00B050';
  if (normalized === '0') return 'FF000000';
  return 'FFA12727';
}

function buildDownloadFileName(report) {
  const [year, month, day] = report.generalData.inspectionDate.slice(0, 10).split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  if (end.getUTCDate() !== day) end.setUTCDate(0);
  const format = (value) => `(${String(value.getUTCDate()).padStart(2, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCFullYear()).slice(-2)})`;
  const code = String(report.agencyFileNameCodeSnapshot || 'SIN-CODIGO')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'SIN-CODIGO';
  return `REV-EXT-${code}-${format(start)}-${format(end)}.xlsx`;
}

function copyRowStyle(source, target) {
  source.eachCell({ includeEmpty: true }, (cell, column) => {
    const destination = target.getCell(column);
    destination.style = structuredClone(cell.style);
    destination.numFmt = cell.numFmt;
    destination.alignment = structuredClone(cell.alignment);
    destination.border = structuredClone(cell.border);
    destination.fill = structuredClone(cell.fill);
    destination.font = structuredClone(cell.font);
    destination.protection = structuredClone(cell.protection);
  });
  target.height = source.height;
}

function validateWorkbook(workbook) {
  const cover = workbook.getWorksheet(SHEETS.cover);
  const inspection = workbook.getWorksheet(SHEETS.inspection);
  if (!cover || !inspection) throw new RevExcelError('La plantilla REV debe contener las hojas CARATULA e INSPECCIÓN.');
  const markers = new Set();
  inspection.getRow(11).eachCell({ includeEmpty: false }, (cell) => {
    const marker = typeof cell.value === 'string' ? cell.value.match(/^\{([^{}]+)\}$/)?.[1] : null;
    if (marker) markers.add(marker);
  });
  const missing = ROW_MARKERS.filter((marker) => !markers.has(marker));
  if (missing.length) throw new RevExcelError(`La fila 11 de la plantilla REV no contiene: ${missing.join(', ')}.`);
  for (const address of ['G3', 'X3', 'G4', 'X4']) {
    if (typeof inspection.getCell(address).value !== 'string'
      || !inspection.getCell(address).value.includes('{')) {
      throw new RevExcelError(`La plantilla REV no contiene el marcador esperado en INSPECCIÓN!${address}.`);
    }
  }
  return { cover, inspection };
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[character]));
}

function normalizeBrand(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function generateRevExcelBuffer(report, { logoBuffer, logoMimeType }) {
  const configuredPath = process.env.REV_EXCEL_TEMPLATE_PATH?.trim();
  let templateBuffer;
  try {
    templateBuffer = await fs.readFile(path.resolve(process.cwd(), configuredPath || DEFAULT_TEMPLATE_PATH));
  } catch (error) {
    throw new RevExcelError('No se pudo leer la plantilla REV configurada.', error);
  }
  if (!Buffer.isBuffer(logoBuffer) || !logoBuffer.length) {
    throw new RevExcelError(`No se encontró un logotipo para la marca ${report.agencyBrandSnapshot || '(sin marca)'}.`);
  }
  const zip = await JSZip.loadAsync(templateBuffer);
  const date = report.generalData.inspectionDate;
  const monthDate = new Date(`${date}T00:00:00.000Z`);
  const month = new Intl.DateTimeFormat('es-MX', { month: 'long', timeZone: 'UTC' })
    .format(monthDate).toLocaleUpperCase('es-MX');
  const coverValues = {
    periodo: [month, date.slice(0, 4)],
    razon: [report.agencyLegalNameSnapshot || report.agencyNameSnapshot],
    sucursal: [report.agencyNameSnapshot],
  };
  const removedCleberRelationships = new Map();
  for (const [drawingPath, entry] of Object.entries(zip.files)) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(drawingPath)) continue;
    let drawingXml = await entry.async('string');
    drawingXml = drawingXml.replace(/<xdr:sp\b[\s\S]*?<\/xdr:sp>/g, (shapeXml) => {
      const shapeName = shapeXml.match(/<xdr:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1];
      const replacementValues = coverValues[shapeName];
      if (!replacementValues) return shapeXml;
      let replacementIndex = 0;
      return shapeXml.replace(/(<a:t>)[\s\S]*?(<\/a:t>)/g, (textXml, opening, closing) => (
        `${opening}${escapeXml(replacementValues[replacementIndex++] ?? '')}${closing}`
      ));
    });
    if (normalizeBrand(report.agencyBrandSnapshot) !== 'CLEBER') {
      drawingXml = drawingXml.replace(/<xdr:(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g, (anchorXml) => {
        const cleberPicture = [...anchorXml.matchAll(/<xdr:pic>[\s\S]*?<\/xdr:pic>/g)]
          .find((match) => /<xdr:cNvPr\b[^>]*\bname="cleber"/.test(match[0]));
        if (!cleberPicture) return anchorXml;
        const relationshipId = cleberPicture[0].match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
        if (relationshipId) {
          const ids = removedCleberRelationships.get(drawingPath) || new Set();
          ids.add(relationshipId);
          removedCleberRelationships.set(drawingPath, ids);
        }
        return '';
      });
    }
    zip.file(drawingPath, drawingXml);
    const relationshipsToRemove = removedCleberRelationships.get(drawingPath);
    if (relationshipsToRemove) {
      const relsPath = pathPosix.join(pathPosix.dirname(drawingPath), '_rels', `${pathPosix.basename(drawingPath)}.rels`);
      const rels = await zip.file(relsPath)?.async('string');
      if (rels) {
        zip.file(relsPath, rels.replace(/<Relationship\b[^>]*\/>/g, (relationship) => (
          relationshipsToRemove.has(relationship.match(/\bId="([^"]+)"/)?.[1]) ? '' : relationship
        )));
      }
    }
  }
  const imageTypes = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'png' };
  if (!imageTypes[logoMimeType]) throw new RevExcelError(`El formato de logotipo ${logoMimeType} no es compatible con la plantilla REV.`);
  let logoReplaced = false;
  const formattedLogos = new Map();
  for (const [drawingPath, entry] of Object.entries(zip.files)) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(drawingPath)) continue;
    const drawingXml = await entry.async('string');
    const logoPictures = [...drawingXml.matchAll(/<xdr:pic>[\s\S]*?<\/xdr:pic>/g)]
      .filter((match) => /<xdr:cNvPr\b[^>]*\bname="logotipo"/.test(match[0]));
    if (!logoPictures.length) continue;
    const relsPath = pathPosix.join(pathPosix.dirname(drawingPath), '_rels', `${pathPosix.basename(drawingPath)}.rels`);
    const rels = await zip.file(relsPath)?.async('string');
    for (const logoPicture of logoPictures) {
      const relationId = logoPicture[0].match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
      const relation = relationId && rels?.match(/<Relationship\b[^>]*\/>/g)
        ?.find((item) => item.match(/\bId="([^"]+)"/)?.[1] === relationId);
      const target = relation?.match(/\bTarget="([^"]+)"/)?.[1];
      if (!target) throw new RevExcelError('La plantilla REV no relaciona la imagen logotipo con un archivo válido.');
      const mediaPath = pathPosix.normalize(pathPosix.join(pathPosix.dirname(drawingPath), target));
      const mediaExtension = pathPosix.extname(mediaPath).slice(1).toLowerCase();
      const targetMime = mediaExtension === 'jpg' || mediaExtension === 'jpeg' ? 'jpeg'
        : mediaExtension === 'png' ? 'png' : '';
      if (!targetMime) throw new RevExcelError(`El formato de imagen de la plantilla ${mediaExtension} no es compatible.`);
      if (!formattedLogos.has(targetMime)) {
        formattedLogos.set(targetMime, await sharp(logoBuffer).toFormat(targetMime).toBuffer());
      }
      zip.file(mediaPath, formattedLogos.get(targetMime));
      logoReplaced = true;
    }
  }
  if (!logoReplaced) throw new RevExcelError('La plantilla REV no contiene una imagen llamada logotipo.');
  templateBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(templateBuffer);
  } catch (error) {
    throw new RevExcelError('La plantilla REV no es un libro Excel válido.', error);
  }
  const { inspection } = validateWorkbook(workbook);
  const values = {
    fecha_inicio: formatDate(date),
    mes: month,
    responsable: report.generalData.responsible || '',
    razon_social: report.agencyLegalNameSnapshot || report.agencyNameSnapshot,
    sucursal: report.agencyNameSnapshot,
  };
  for (const [address, value] of [['G3', values.fecha_inicio], ['X3', values.mes], ['G4', values.responsable]]) {
    inspection.getCell(address).value = value;
  }
  inspection.getCell('X4').value = `${values.razon_social} - SUCURSAL ${values.sucursal}`;

  const extinguishers = report.extinguishers || [];
  if (extinguishers.length > 1) inspection.spliceRows(12, 0, ...Array(extinguishers.length - 1).fill([]));
  extinguishers.forEach((extinguisher, index) => {
    const rowNumber = 11 + index;
    const row = inspection.getRow(rowNumber);
    if (index > 0) copyRowStyle(inspection.getRow(11), row);
    for (const [column, marker] of ROW_MARKERS.entries()) {
      const target = row.getCell(column + 1);
      if (index === 0 && target.value !== `{${marker}}`) {
        throw new RevExcelError(`El marcador {${marker}} no está en la columna esperada de la fila ${rowNumber}.`);
      }
      const field = marker === 'señalizacion' ? 'senalizacion' : marker;
      target.value = marker === 'fecha_carga' || marker === 'fecha_vencimiento'
        ? formatDate(extinguisher[field])
        : marker === 'ubicacion'
          ? extinguisher.ubicacion || report.agencyAddressSnapshot || ''
          : extinguisher[field] ?? '';
      if (CHECK_MARKERS.has(marker)) {
        const fontColor = getCheckFontColor(target.value);
        if (fontColor) {
          target.style = {
            ...structuredClone(target.style),
            font: { ...structuredClone(target.font), color: { argb: fontColor } },
          };
        }
      }
    }
    row.commit();
  });
  if (!extinguishers.length) {
    inspection.getRow(11).eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === 'string' && /^\{[^{}]+\}$/.test(cell.value)) cell.value = '';
    });
  }
  let buffer;
  try {
    const generatedZip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
    const coverDrawingPaths = Object.keys(zip.files)
      .filter((entryPath) => /^xl\/drawings\/drawing\d+\.xml$/.test(entryPath));
    for (const drawingPath of coverDrawingPaths) {
      const generatedDrawingPath = generatedZip.file(drawingPath);
      if (!generatedDrawingPath) throw new RevExcelError(`No se pudo conservar el dibujo ${drawingPath} de la plantilla REV.`);
      const drawing = await zip.file(drawingPath).async('nodebuffer');
      generatedZip.file(drawingPath, drawing);
      const relsPath = `${pathPosix.dirname(drawingPath)}/_rels/${pathPosix.basename(drawingPath)}.rels`;
      const rels = await zip.file(relsPath)?.async('nodebuffer');
      if (rels) generatedZip.file(relsPath, rels);
    }
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      if (/^xl\/media\//.test(entryPath) && !entry.dir) {
        generatedZip.file(entryPath, await entry.async('nodebuffer'));
      }
    }
    buffer = await generatedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch (error) {
    if (error instanceof RevExcelError) throw error;
    throw new RevExcelError('No se pudo exportar el libro REV.', error);
  }
  const verification = new ExcelJS.Workbook();
  await verification.xlsx.load(buffer);
  const pending = [];
  for (const worksheet of verification.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === 'string' && /\{[^{}]+\}/.test(cell.value)) pending.push(`${worksheet.name}!${cell.address}`);
    }));
  }
  if (pending.length) throw new RevExcelError(`Quedaron marcadores REV sin resolver: ${pending.join(', ')}.`);
  return { buffer, templateVersion: TEMPLATE_VERSION, downloadFileName: buildDownloadFileName(report) };
}

module.exports = { DEFAULT_TEMPLATE_PATH, RevExcelError, TEMPLATE_VERSION, buildDownloadFileName, generateRevExcelBuffer };
