'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const { ASPECTS } = require('../formats/forAudAmb');
const { isValidInspectionDate, sanitizeOriginalName } = require('./forReportService');

const TEMPLATE_VERSION = '1.1';
const DEFAULT_TEMPLATE_PATH = path.join(__dirname, '../templates/FOR-AUD-AMB-v1.xlsx');
const EXPECTED_SHEETS = ['DATOS', 'EVIDENCIA', 'APLICA'];
const EVIDENCE_COUNT = 20;
const MAX_IMAGES_PER_EVIDENCE = 4;
const EMU_PER_PIXEL = 9525;
const MAX_IMAGE_SIDE_PX = 1600;
const IMAGE_JPEG_QUALITY = 82;
const CATEGORY_CODES = {
  'carpeta-ambiental': { answer: 'a', comment: 'ca' },
  taller: { answer: 'b', comment: 'cb' },
  'area-lavado': { answer: 'c', comment: 'cc' },
  'almacen-temporal-residuos-peligrosos': { answer: 'd', comment: 'cd' },
  'almacen-temporal-manejo-especial': { answer: 'e', comment: 'ce' },
};

class ForReportExcelError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'ForReportExcelError';
  }
}

function markerInventory() {
  const expected = new Map();
  for (const [marker, sheetName] of [
    ['{nombre_empresa}', 'DATOS'],
    ['{fecha_recorrido}', 'DATOS'],
    ['{visita}', 'DATOS'],
    ['{observaciones}', 'DATOS'],
    ['{agencia}', 'APLICA'],
  ]) {
    expected.set(marker, sheetName);
  }
  for (let index = 1; index <= EVIDENCE_COUNT; index += 1) {
    expected.set(`{evidencia${index}}`, 'EVIDENCIA');
    expected.set(`{imagen${index}}`, 'EVIDENCIA');
    expected.set(`{descripcion${index}}`, 'EVIDENCIA');
  }
  const counts = new Map();
  for (const aspect of ASPECTS) {
    const category = CATEGORY_CODES[aspect.categoryId];
    if (!category) throw new ForReportExcelError(`No existe un prefijo Excel para ${aspect.categoryId}.`);
    const index = (counts.get(aspect.categoryId) || 0) + 1;
    counts.set(aspect.categoryId, index);
    expected.set(`{${category.answer}${index}}`, 'APLICA');
    expected.set(`{${category.comment}${index}}`, 'APLICA');
  }
  return expected;
}

function getCellMarkers(workbook) {
  const locations = new Map();
  const unknown = [];
  const expected = markerInventory();
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.address !== cell.master.address) return;
        if (typeof cell.value !== 'string' || !/^\{[^{}]+\}$/.test(cell.value)) return;
        const location = { sheetName: worksheet.name, address: cell.address, worksheet };
        const current = locations.get(cell.value) || [];
        current.push(location);
        locations.set(cell.value, current);
        if (!expected.has(cell.value)) unknown.push(`${worksheet.name}!${cell.address}=${cell.value}`);
      });
    });
  }
  return { locations, unknown };
}

function validateWorkbook(workbook) {
  const missingSheets = EXPECTED_SHEETS.filter((name) => !workbook.getWorksheet(name));
  if (missingSheets.length) {
    throw new ForReportExcelError(`La plantilla no contiene las hojas requeridas: ${missingSheets.join(', ')}.`);
  }
  const expected = markerInventory();
  const { locations, unknown } = getCellMarkers(workbook);
  const missing = [];
  const duplicates = [];
  for (const [marker, sheetName] of expected) {
    const cells = locations.get(marker) || [];
    if (!cells.length) missing.push(marker);
    else if (cells.length > 1) duplicates.push(marker);
    else if (cells[0].sheetName !== sheetName) {
      throw new ForReportExcelError(`${marker} debe estar en la hoja ${sheetName}; se encontró en ${cells[0].sheetName}.`);
    }
  }
  if (missing.length || duplicates.length || unknown.length) {
    const problems = [
      missing.length ? `faltan ${missing.join(', ')}` : '',
      duplicates.length ? `están duplicados ${duplicates.join(', ')}` : '',
      unknown.length ? `no se reconocen ${unknown.join(', ')}` : '',
    ].filter(Boolean);
    throw new ForReportExcelError(`La plantilla no pasó la validación: ${problems.join('; ')}.`);
  }
  return locations;
}

function buildAspectMarkerMap() {
  const counts = new Map();
  const result = new Map();
  for (const aspect of ASPECTS) {
    const code = CATEGORY_CODES[aspect.categoryId];
    const index = (counts.get(aspect.categoryId) || 0) + 1;
    counts.set(aspect.categoryId, index);
    result.set(aspect.id, {
      answer: `{${code.answer}${index}}`,
      observation: `{${code.comment}${index}}`,
    });
  }
  return result;
}

function buildReportValues(report) {
  const generalData = report.generalData || {};
  const legalName = String(generalData.legalName || '').trim();
  const companyName = String(generalData.companyName || report.agencyNameSnapshot || '').trim();
  const date = generalData.inspectionDate;
  if (!isValidInspectionDate(date)) {
    throw new ForReportExcelError('La fecha del recorrido no es válida para generar el Excel.');
  }
  const values = new Map([
    ['{nombre_empresa}', legalName ? `${legalName} · ${companyName}` : companyName],
    ['{fecha_recorrido}', `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`],
    ['{visita}', Number(generalData.visitNumber) || 1],
    ['{observaciones}', String(generalData.observations || '')],
    ['{agencia}', companyName],
  ]);
  const aspects = new Map((report.environmentalAspects || []).map((aspect) => [aspect.aspectId, aspect]));
  for (const [aspectId, markers] of buildAspectMarkerMap()) {
    const aspect = aspects.get(aspectId);
    const answer = aspect?.answer;
    values.set(markers.answer, answer === '1' ? 1 : answer === '0' ? 0 : answer || '');
    values.set(markers.observation, aspect?.observation || '');
  }
  const evidence = (report.evidence || []).filter((entry) => entry.status === 'active');
  if (evidence.length > EVIDENCE_COUNT) {
    throw new ForReportExcelError(`El reporte excede el máximo de ${EVIDENCE_COUNT} evidencias.`);
  }
  const evidenceById = [];
  for (let index = 1; index <= EVIDENCE_COUNT; index += 1) {
    const entry = evidence[index - 1];
    const activeImages = (entry?.images || []).filter((image) => image.status === 'active');
    const pendingImages = (entry?.images || []).filter((image) => image.status === 'pending');
    if (pendingImages.length) {
      throw new ForReportExcelError(`La evidencia ${index} tiene imágenes que aún no terminan de cargarse.`);
    }
    if (activeImages.length > MAX_IMAGES_PER_EVIDENCE) {
      throw new ForReportExcelError(`La evidencia ${index} excede el máximo de ${MAX_IMAGES_PER_EVIDENCE} imágenes.`);
    }
    if (activeImages.some((image) => !image.driveFileId)) {
      throw new ForReportExcelError(`La evidencia ${index} tiene una imagen activa sin archivo almacenado.`);
    }
    const description = String(entry?.description || '');
    const used = Boolean(entry && (description.trim() || activeImages.length));
    values.set(`{evidencia${index}}`, used ? `Evidencia ${index}` : '');
    values.set(`{imagen${index}}`, '');
    values.set(`{descripcion${index}}`, description);
    evidenceById.push(used ? { entry, images: activeImages } : null);
  }
  return { values, evidence: evidenceById };
}

function safeFileNamePart(value, fallback) {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function buildDownloadFileName(report) {
  const date = report.generalData.inspectionDate;
  const day = date.slice(8, 10);
  const month = date.slice(5, 7);
  const year = date.slice(0, 4);
  const endDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  if (endDate.getUTCDate() !== Number(day)) endDate.setUTCDate(0);
  const endToken = `(${String(endDate.getUTCDate()).padStart(2, '0')}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${endDate.getUTCFullYear()})`;
  const startToken = `(${day}-${month}-${year})`;
  const agencyCode = safeFileNamePart(report.agencyFileNameCodeSnapshot, 'SIN-CODIGO');
  return `FOR-AUD-AMB-${agencyCode}-${startToken}-${endToken}.xlsx`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractSharedString(entry) {
  return [...entry.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => xmlUnescape(match[1]))
    .join('');
}

function replaceSharedStringAtIndex(xml, index, value) {
  let currentIndex = 0;
  let replaced = false;
  const updated = xml.replace(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g, (entry) => {
    if (currentIndex !== index) {
      currentIndex += 1;
      return entry;
    }
    currentIndex += 1;
    replaced = true;
    const textNode = /(<t(?:\s[^>]*)?>)[\s\S]*?(<\/t>)/;
    if (!textNode.test(entry)) throw new ForReportExcelError('La plantilla contiene un marcador sin nodo de texto editable.');
    return entry.replace(textNode, `$1${xmlEscape(value)}$2`);
  });
  if (!replaced) throw new ForReportExcelError('No se pudo localizar un marcador en las cadenas compartidas de la plantilla.');
  return updated;
}

function replaceInlineCell(xml, address, value) {
  const expression = new RegExp(`(<c\\b(?=[^>]*\\br="${address}")[^>]*>)([\\s\\S]*?)(<\\/c>)`);
  const match = xml.match(expression);
  if (!match) throw new ForReportExcelError(`No se localizó la celda ${address} en la hoja de la plantilla.`);
  const content = match[2].replace(/<is(?:\s[^>]*)?>[\s\S]*?<\/is>/, `<is><t>${xmlEscape(value)}</t></is>`);
  if (content === match[2]) throw new ForReportExcelError(`La celda ${address} no contiene texto editable.`);
  return xml.replace(expression, `$1${content}$3`);
}

function replaceCellWithNumber(xml, address, value) {
  const expression = new RegExp(`(<c\\b(?=[^>]*\\br="${address}")[^>]*)(>[\\s\\S]*?<\\/c>)`);
  const match = xml.match(expression);
  if (!match) throw new ForReportExcelError(`No se localizó la celda ${address} en la hoja de la plantilla.`);
  const attributes = match[1].replace(/\s+t="[^"]*"/, '');
  const content = match[2].replace(/>[\s\S]*<\/c>$/, ` t="n"><v>${value}</v></c>`);
  return xml.replace(expression, `${attributes}${content}`);
}

async function replaceWorkbookMarkers(zip, markerLocations, values, sheetFiles) {
  const sharedStrings = zip.file('xl/sharedStrings.xml');
  const initialSharedStrings = sharedStrings ? await sharedStrings.async('string') : '';
  let updatedSharedStrings = initialSharedStrings;
  const modifiedSheets = new Map();
  for (const [marker, locationList] of markerLocations) {
    if (locationList.length !== 1 || !values.has(marker)) {
      throw new ForReportExcelError(`No hay un valor único para el marcador ${marker}.`);
    }
    const { address, sheetName } = locationList[0];
    const sheetPath = sheetFiles.get(sheetName);
    if (!sheetPath) throw new ForReportExcelError(`No se encontró el XML de la hoja ${sheetName}.`);
    let sheetXml = modifiedSheets.get(sheetPath);
    if (!sheetXml) {
      sheetXml = await zip.file(sheetPath)?.async('string');
      if (!sheetXml) throw new ForReportExcelError(`No se pudo leer la hoja ${sheetName} de la plantilla.`);
    }
    const replacement = values.get(marker);
    const cellRegex = new RegExp(`<c\\b(?=[^>]*\\br="${address}")[^>]*>([\\s\\S]*?)<\\/c>`);
    const cellXml = sheetXml.match(cellRegex)?.[0];
    if (!cellXml) throw new ForReportExcelError(`No se encontró ${sheetName}!${address} en el archivo de la plantilla.`);
    const type = cellXml.match(/\bt="([^"]+)"/)?.[1];
    if (type === 's') {
      if (!updatedSharedStrings) throw new ForReportExcelError('La plantilla referencia cadenas compartidas, pero no contiene sharedStrings.xml.');
      const sharedIndex = Number(cellXml.match(/<v>(\d+)<\/v>/)?.[1]);
      const entry = [...updatedSharedStrings.matchAll(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g)][sharedIndex]?.[0];
      if (!entry || extractSharedString(entry) !== marker) {
        throw new ForReportExcelError(`El marcador ${marker} no coincide con su cadena compartida.`);
      }
      if (typeof replacement === 'number') {
        updatedSharedStrings = replaceSharedStringAtIndex(updatedSharedStrings, sharedIndex, '');
        sheetXml = replaceCellWithNumber(sheetXml, address, replacement);
      } else {
        updatedSharedStrings = replaceSharedStringAtIndex(updatedSharedStrings, sharedIndex, replacement);
      }
    } else if (type === 'inlineStr' && typeof replacement === 'string') {
      sheetXml = replaceInlineCell(sheetXml, address, replacement);
    } else {
      throw new ForReportExcelError(`La celda ${sheetName}!${address} tiene un tipo de valor no compatible.`);
    }
    modifiedSheets.set(sheetPath, sheetXml);
  }
  for (const [sheetPath, sheetXml] of modifiedSheets) zip.file(sheetPath, sheetXml);
  if (sharedStrings && updatedSharedStrings !== initialSharedStrings) {
    zip.file('xl/sharedStrings.xml', updatedSharedStrings);
  }
}

function getAttributes(value) {
  const attributes = {};
  for (const match of value.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes[match[1]] = xmlUnescape(match[2]);
  }
  return attributes;
}

function getRelationshipTargetPath(relationshipsPath, target) {
  const normalized = target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(path.posix.dirname(relationshipsPath)), target));
  return normalized.startsWith('xl/') ? normalized : `xl/${normalized}`;
}

async function getSheetFiles(zip) {
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbookXml || !relationshipsXml) throw new ForReportExcelError('La plantilla no contiene las relaciones de libro requeridas.');
  const relations = new Map();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = getAttributes(match[1]);
    relations.set(attrs.Id, attrs.Target);
  }
  const files = new Map();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = getAttributes(match[1]);
    const target = relations.get(attrs['r:id']);
    if (target) files.set(attrs.name, getRelationshipTargetPath('xl/_rels/workbook.xml.rels', target));
  }
  return files;
}

function columnNumber(reference) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) throw new ForReportExcelError(`La referencia de celda ${reference} no es válida.`);
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function columnName(number) {
  let value = number;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellCoordinates(address) {
  const match = address.match(/^([A-Z]+)(\d+)$/i);
  if (!match) throw new ForReportExcelError(`La celda ${address} no tiene coordenadas válidas.`);
  return { col: columnNumber(match[1]), row: Number(match[2]) };
}

function mergeRangeForCell(worksheet, address) {
  const range = (worksheet.model.merges || []).find((merge) => merge.split(':')[0] === address);
  if (!range) throw new ForReportExcelError(`El área de imagen ${worksheet.name}!${address} no está combinada en la plantilla.`);
  const [start, end] = range.split(':');
  const from = cellCoordinates(start);
  const to = cellCoordinates(end);
  return { startCol: from.col, startRow: from.row, endCol: to.col, endRow: to.row };
}

function columnWidthPixels(worksheet, column) {
  const width = worksheet.getColumn(column).width || worksheet.properties.defaultColWidth || 8.43;
  return Math.max(1, Math.floor(width * 7 + 5));
}

function rowHeightPixels(worksheet, row) {
  const height = worksheet.getRow(row).height || worksheet.properties.defaultRowHeight || 15;
  return Math.max(1, Math.floor((height * 96) / 72));
}

function axisPositionToCell(start, offsetPixels, sizeAt) {
  let remaining = offsetPixels;
  let index = start;
  while (remaining >= sizeAt(index)) {
    remaining -= sizeAt(index);
    index += 1;
  }
  return { index: index - 1, offset: Math.max(0, Math.round(remaining * EMU_PER_PIXEL)) };
}

function anchorPosition(worksheet, area, x, y) {
  const col = axisPositionToCell(area.startCol, x, (index) => columnWidthPixels(worksheet, index));
  const row = axisPositionToCell(area.startRow, y, (index) => rowHeightPixels(worksheet, index));
  return { col: col.index, colOff: col.offset, row: row.index, rowOff: row.offset };
}

function buildPictureAnchor(worksheet, area, tile, imageRelationshipId, imageIndex, name) {
  const x = tile.x;
  const y = tile.y;
  const width = tile.width;
  const height = tile.height;
  const from = anchorPosition(worksheet, area, x, y);
  const to = anchorPosition(worksheet, area, x + width, y + height);
  return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${from.col}</xdr:col><xdr:colOff>${from.colOff}</xdr:colOff><xdr:row>${from.row}</xdr:row><xdr:rowOff>${from.rowOff}</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to.col}</xdr:col><xdr:colOff>${to.colOff}</xdr:colOff><xdr:row>${to.row}</xdr:row><xdr:rowOff>${to.rowOff}</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${imageIndex}" name="${xmlEscape(name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${imageRelationshipId}" cstate="print"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(width * EMU_PER_PIXEL)}" cy="${Math.round(height * EMU_PER_PIXEL)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
}

function splitEvidenceTiles(images, area) {
  const margin = 4;
  const width = area.width;
  const height = area.height;
  const buildSlots = (columns) => {
    const rows = Math.ceil(images.length / columns);
    const slotHeight = height / rows;
    return Array.from({ length: images.length }, (_, index) => {
      const row = Math.floor(index / columns);
      const inRow = Math.min(columns, images.length - row * columns);
      const slotWidth = width / inRow;
      return { x: slotWidth * (index - row * columns), y: slotHeight * row, width: slotWidth, height: slotHeight };
    });
  };
  const fittedArea = (slots) => slots.reduce((total, slot, index) => {
    const ratio = images[index].width / images[index].height;
    const w = Math.min(Math.max(1, slot.width - margin * 2), Math.max(1, slot.height - margin * 2) * ratio);
    return total + w * (w / ratio);
  }, 0);
  // Elige la cuadrícula que aproveche más espacio (p. ej. 2x2 para 4 imágenes).
  let slots = buildSlots(1);
  let bestArea = fittedArea(slots);
  for (let columns = 2; columns <= images.length; columns += 1) {
    const candidate = buildSlots(columns);
    const area = fittedArea(candidate);
    if (area > bestArea) {
      slots = candidate;
      bestArea = area;
    }
  }
  return slots.map((slot, index) => {
    const availableWidth = Math.max(1, slot.width - margin * 2);
    const availableHeight = Math.max(1, slot.height - margin * 2);
    const ratio = images[index].width / images[index].height;
    const fittedWidth = Math.min(availableWidth, availableHeight * ratio);
    const fittedHeight = fittedWidth / ratio;
    return {
      x: slot.x + (slot.width - fittedWidth) / 2,
      y: slot.y + (slot.height - fittedHeight) / 2,
      width: fittedWidth,
      height: fittedHeight,
    };
  });
}

async function loadDriveImage(drive, driveFileId) {
  const response = await drive.files.get(
    { fileId: driveFileId, alt: 'media' },
    { responseType: 'stream' },
  );
  const chunks = [];
  for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
  if (!chunks.length) throw new ForReportExcelError('Una imagen de evidencia no devolvió contenido.');
  return Buffer.concat(chunks);
}

async function insertEvidencePictures({ zip, drive, report, evidence, markerLocations, worksheet, sheetFiles }) {
  const items = [];
  for (const [index, item] of evidence.entries()) {
    if (!item) continue;
    const marker = `{imagen${index + 1}}`;
    const location = markerLocations.get(marker)?.[0];
    if (!location) throw new ForReportExcelError(`No se encontró el área de imagen ${marker}.`);
    const area = mergeRangeForCell(worksheet, location.address);
    const startCol = columnNumber(columnName(area.startCol));
    const startRow = area.startRow;
    area.width = 0;
    for (let col = area.startCol; col <= area.endCol; col += 1) {
      area.width += columnWidthPixels(worksheet, col);
    }
    area.height = 0;
    for (let row = area.startRow; row <= area.endRow; row += 1) {
      area.height += rowHeightPixels(worksheet, row);
    }
    area.startCol = startCol;
    area.startRow = startRow;
    const images = [];
    for (const image of item.images) {
      const source = await loadDriveImage(drive, image.driveFileId);
      const processed = await sharp(source, { limitInputPixels: 100_000_000 })
        .rotate()
        .resize({ width: MAX_IMAGE_SIDE_PX, height: MAX_IMAGE_SIDE_PX, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:4:4' })
        .toBuffer({ resolveWithObject: true });
      images.push({ buffer: processed.data, width: processed.info.width, height: processed.info.height });
    }
    const tiles = splitEvidenceTiles(images, area);
    items.push({ evidenceNumber: index + 1, area, images, tiles });
  }
  if (!items.length) return;

  const sheetPath = sheetFiles.get('EVIDENCIA');
  const worksheetRelationshipsPath = path.posix.join(path.posix.dirname(sheetPath), '_rels', `${path.posix.basename(sheetPath)}.rels`);
  const worksheetRelationships = await zip.file(worksheetRelationshipsPath)?.async('string');
  const drawingRelation = [...(worksheetRelationships || '').matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => getAttributes(match[1]))
    .find((attrs) => attrs.Type?.endsWith('/drawing'));
  if (!drawingRelation) throw new ForReportExcelError('La hoja EVIDENCIA no tiene un vínculo a su dibujo de plantilla.');
  const drawingPath = getRelationshipTargetPath(worksheetRelationshipsPath, drawingRelation.Target);
  let drawingXml = await zip.file(drawingPath)?.async('string');
  if (!drawingXml?.includes('</xdr:wsDr>')) throw new ForReportExcelError('No se pudo abrir el dibujo de la hoja EVIDENCIA.');
  const drawingRelationshipsPath = path.posix.join(path.posix.dirname(drawingPath), '_rels', `${path.posix.basename(drawingPath)}.rels`);
  let drawingRelationships = await zip.file(drawingRelationshipsPath)?.async('string');
  if (!drawingRelationships) {
    drawingRelationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  }
  let nextRelationship = Math.max(0, ...[...drawingRelationships.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]))) + 1;
  let nextPictureId = Math.max(0, ...[...drawingXml.matchAll(/<xdr:cNvPr\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1]))) + 1;
  let anchors = '';
  const imageRelations = [];
  for (const item of items) {
    for (const [imageIndex, image] of item.images.entries()) {
      const relationshipId = `rId${nextRelationship}`;
      const fileName = `image${nextPictureId}.png`;
      const target = `../media/${fileName}`;
      zip.file(path.posix.join(path.posix.dirname(drawingPath), '..', 'media', fileName), image.buffer);
      imageRelations.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`);
      anchors += buildPictureAnchor(
        worksheet,
        item.area,
        item.tiles[imageIndex],
        relationshipId,
        nextPictureId,
        sanitizeOriginalName(`Evidencia ${item.evidenceNumber} imagen ${imageIndex + 1}`),
      );
      nextRelationship += 1;
      nextPictureId += 1;
    }
  }
  drawingXml = drawingXml.replace('</xdr:wsDr>', `${anchors}</xdr:wsDr>`);
  zip.file(drawingPath, drawingXml);
  drawingRelationships = drawingRelationships.replace('</Relationships>', `${imageRelations.join('')}</Relationships>`);
  zip.file(drawingRelationshipsPath, drawingRelationships);
  await addContentTypeDefault(zip, 'jpeg', 'image/jpeg');
}

async function addContentTypeDefault(zip, extension, contentType) {
  const pathName = '[Content_Types].xml';
  let xml = await zip.file(pathName)?.async('string');
  if (!xml) throw new ForReportExcelError('La plantilla no contiene [Content_Types].xml.');
  const hasDefault = [...xml.matchAll(/<Default\b([^>]*)\/>/g)]
    .map((match) => getAttributes(match[1]))
    .some((attributes) => attributes.Extension?.toLowerCase() === extension.toLowerCase());
  if (!hasDefault) {
    xml = xml.replace('</Types>', `<Default Extension="${extension}" ContentType="${contentType}"/></Types>`);
    zip.file(pathName, xml);
  }
}

function compressColumns(columns) {
  const sorted = [...columns].sort((a, b) => a - b);
  const ranges = [];
  for (const column of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.max + 1 === column) last.max = column;
    else ranges.push({ min: column, max: column });
  }
  return ranges;
}

function updateColumnVisibility(sheetXml, hiddenColumns) {
  if (!hiddenColumns.size) return sheetXml;
  const columnsMatch = sheetXml.match(/<cols(?:\s[^>]*)?>[\s\S]*?<\/cols>/);
  const original = [];
  for (const match of (columnsMatch?.[0] || '').matchAll(/<col\b([^>]*)\/>/g)) {
    const attrs = getAttributes(match[1]);
    original.push({ min: Number(attrs.min), max: Number(attrs.max), attrs });
  }
  const maximum = Math.max(
    ...original.map(({ max }) => max),
    ...hiddenColumns,
  );
  const boundaries = new Set([1, maximum + 1]);
  original.forEach(({ min, max }) => { boundaries.add(min); boundaries.add(max + 1); });
  hiddenColumns.forEach((column) => { boundaries.add(column); boundaries.add(column + 1); });
  const sorted = [...boundaries].sort((a, b) => a - b);
  const segments = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const min = sorted[index];
    const max = sorted[index + 1] - 1;
    const definition = [...original].reverse().find((item) => item.min <= min && item.max >= min);
    const attrs = definition ? { ...definition.attrs } : {};
    if (Array.from({ length: max - min + 1 }, (_, offset) => hiddenColumns.has(min + offset)).every(Boolean)) {
      attrs.hidden = '1';
    } else if (attrs.hidden === '1') {
      delete attrs.hidden;
    }
    attrs.min = String(min);
    attrs.max = String(max);
    const last = segments[segments.length - 1];
    const comparable = (item) => JSON.stringify(Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== 'min' && key !== 'max'),
    ));
    if (last && last.max + 1 === min && comparable(last.attrs) === comparable(attrs)) {
      last.max = max;
      last.attrs.max = String(max);
    }
    else segments.push({ min, max, attrs });
  }
  const cols = `<cols>${segments.map(({ attrs }) => (
    `<col ${Object.entries(attrs).map(([key, value]) => `${key}="${xmlEscape(value)}"`).join(' ')}/>`
  )).join('')}</cols>`;
  if (columnsMatch) return sheetXml.replace(columnsMatch[0], cols);
  return sheetXml.replace('<sheetData', `${cols}<sheetData`);
}

function updateRowVisibility(sheetXml, hiddenRows) {
  if (!hiddenRows.size) return sheetXml;
  return sheetXml.replace(/<row\b([^>]*)>/g, (rowXml, attributes) => {
    const rowNumber = Number(attributes.match(/\br="(\d+)"/)?.[1]);
    if (!hiddenRows.has(rowNumber)) return rowXml;
    const updatedAttributes = /\bhidden="[^"]*"/.test(attributes)
      ? attributes.replace(/\bhidden="[^"]*"/, 'hidden="1"')
      : `${attributes} hidden="1"`;
    return `<row${updatedAttributes}>`;
  });
}

async function hideNotApplicableCategoryRows({ zip, markerLocations, sheetFiles, notApplicableCategories }) {
  const hiddenRows = new Set();
  for (const categoryId of notApplicableCategories) {
    const category = CATEGORY_CODES[categoryId];
    if (!category) throw new ForReportExcelError(`La sección no aplicable ${categoryId} no es válida.`);
    const matchingMarkers = [...markerLocations.keys()].filter((marker) => (
      new RegExp(`^\\{${category.answer}\\d+\\}$`).test(marker)
    ));
    if (!matchingMarkers.length) throw new ForReportExcelError(`No se encontraron preguntas para ${categoryId}.`);
    const rows = matchingMarkers.map((marker) => markerLocations.get(marker)[0].address)
      .map((address) => Number(address.match(/\d+$/)[0]));
    for (let row = Math.min(...rows); row <= Math.max(...rows); row += 1) hiddenRows.add(row);
  }
  if (!hiddenRows.size) return;
  const sheetPath = sheetFiles.get('APLICA');
  const sheetXml = await zip.file(sheetPath)?.async('string');
  if (!sheetXml) throw new ForReportExcelError('No se pudo leer la hoja APLICA de la plantilla.');
  zip.file(sheetPath, updateRowVisibility(sheetXml, hiddenRows));
}

async function hideUnusedEvidenceColumns({ zip, evidence, markerLocations, sheetFiles }) {
  const sheetPath = sheetFiles.get('EVIDENCIA');
  const worksheet = await zip.file(sheetPath)?.async('string');
  if (!worksheet) throw new ForReportExcelError('No se pudo leer la hoja EVIDENCIA.');
  const hiddenColumns = new Set();
  for (let index = 1; index <= EVIDENCE_COUNT; index += 1) {
    if (evidence[index - 1]) continue;
    const markerCell = markerLocations.get(`{evidencia${index}}`)?.[0];
    if (!markerCell) throw new ForReportExcelError(`No se encontró el bloque de evidencia ${index}.`);
    const range = mergeRangeForCell(markerCell.worksheet, markerCell.address);
    const first = columnNumber(columnName(range.startCol));
    const last = columnNumber(columnName(range.endCol));
    const separator = index < EVIDENCE_COUNT ? last + 1 : null;
    const blockColumns = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
    blockColumns.forEach((column) => hiddenColumns.add(column));
    if (separator) hiddenColumns.add(separator);
  }
  zip.file(sheetPath, updateColumnVisibility(worksheet, hiddenColumns));
}

async function verifyGeneratedWorkbook(buffer, expectedValues, expectedImageCount, templateZip) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    throw new ForReportExcelError('El archivo generado no se puede abrir como un libro Excel válido.', error);
  }
  const missingSheets = EXPECTED_SHEETS.filter((name) => !workbook.getWorksheet(name));
  if (missingSheets.length) throw new ForReportExcelError(`El Excel generado no contiene: ${missingSheets.join(', ')}.`);
  const loadedImageCount = workbook.getWorksheet('EVIDENCIA').getImages().length;
  if (loadedImageCount !== expectedImageCount) {
    throw new ForReportExcelError('El libro Excel no reconoce todas las fotografías de evidencia incorporadas.');
  }
  for (const [sheetName, cellValues] of expectedValues) {
    const worksheet = workbook.getWorksheet(sheetName);
    for (const [address, expected] of cellValues) {
      const actual = worksheet.getCell(address).value;
      if (actual !== expected) {
        throw new ForReportExcelError(`La validación de ${sheetName}!${address} no coincide con el dato solicitado.`);
      }
    }
  }
  const expectedMarkers = markerInventory();
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.address !== cell.master.address) return;
        if (typeof cell.value === 'string' && expectedMarkers.has(cell.value)) {
          throw new ForReportExcelError(`El marcador ${cell.value} quedó sin resolver en ${worksheet.name}!${cell.address}.`);
        }
      });
    });
  }
  const zip = await JSZip.loadAsync(buffer);
  const evidenceSheetPath = (await getSheetFiles(zip)).get('EVIDENCIA');
  const relationshipsPath = path.posix.join(path.posix.dirname(evidenceSheetPath), '_rels', `${path.posix.basename(evidenceSheetPath)}.rels`);
  const relationsXml = await zip.file(relationshipsPath)?.async('string');
  const drawingRelationship = [...(relationsXml || '').matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => getAttributes(match[1]))
    .find((attrs) => attrs.Type?.endsWith('/drawing'));
  const drawingPath = drawingRelationship ? getRelationshipTargetPath(relationshipsPath, drawingRelationship.Target) : '';
  const drawingRelationshipsPath = drawingPath
    ? path.posix.join(path.posix.dirname(drawingPath), '_rels', `${path.posix.basename(drawingPath)}.rels`)
    : '';
  const generatedDrawing = drawingPath ? await zip.file(drawingPath)?.async('string') : '';
  const templateDrawingPath = (await getSheetFiles(templateZip)).get('EVIDENCIA');
  const templateRelationshipsPath = path.posix.join(path.posix.dirname(templateDrawingPath), '_rels', `${path.posix.basename(templateDrawingPath)}.rels`);
  const templateRelationshipsXml = await templateZip.file(templateRelationshipsPath)?.async('string');
  const templateDrawingRelationship = [...(templateRelationshipsXml || '').matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => getAttributes(match[1]))
    .find((attrs) => attrs.Type?.endsWith('/drawing'));
  const originalDrawingPath = templateDrawingRelationship
    ? getRelationshipTargetPath(templateRelationshipsPath, templateDrawingRelationship.Target)
    : '';
  const originalDrawing = originalDrawingPath ? await templateZip.file(originalDrawingPath)?.async('string') : '';
  const shapeCount = (xml) => [...String(xml).matchAll(/<xdr:sp>/g)].length;
  const pictureCount = (xml) => [...String(xml).matchAll(/<xdr:pic>/g)].length;
  if (shapeCount(generatedDrawing) !== shapeCount(originalDrawing)) {
    throw new ForReportExcelError('La validación detectó cambios en los objetos gráficos existentes de la plantilla.');
  }
  if (pictureCount(generatedDrawing) - pictureCount(originalDrawing) !== expectedImageCount) {
    throw new ForReportExcelError('La cantidad de fotografías del Excel generado no coincide con las evidencias.');
  }
  const pictureRelationships = new Map(
    [...(await zip.file(drawingRelationshipsPath)?.async('string') || '').matchAll(/<Relationship\b([^>]*)\/>/g)]
      .map((match) => getAttributes(match[1]))
      .filter((attributes) => attributes.Type?.endsWith('/image'))
      .map((attributes) => [attributes.Id, attributes.Target]),
  );
  for (const match of String(generatedDrawing).matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
    const target = pictureRelationships.get(match[1]);
    if (!target) throw new ForReportExcelError(`La fotografía ${match[1]} no tiene una relación válida en el libro.`);
    const mediaPath = getRelationshipTargetPath(drawingRelationshipsPath, target);
    const mediaFile = await zip.file(mediaPath)?.async('nodebuffer');
    if (!mediaFile?.length) throw new ForReportExcelError(`No se encontró el contenido de la fotografía ${match[1]}.`);
    try {
      await sharp(mediaFile).metadata();
    } catch (error) {
      throw new ForReportExcelError(`La fotografía ${match[1]} no se puede abrir.`, error);
    }
  }
}

function getTemplateDownloadUrl(value) {
  const url = new URL(value);
  if (url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/d/')) {
    const spreadsheetId = url.pathname.split('/')[3];
    if (!spreadsheetId) throw new ForReportExcelError('La URL de Google Sheets no contiene un ID válido.');
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=xlsx`;
  }
  return url.toString();
}

async function loadTemplateBuffer(templateLocation) {
  if (!/^https?:\/\//i.test(templateLocation)) return fs.readFile(templateLocation);
  let response;
  try {
    response = await fetch(getTemplateDownloadUrl(templateLocation));
  } catch (error) {
    throw new ForReportExcelError('No se pudo descargar la plantilla oficial de FOR-AUD-AMB.', error);
  }
  if (!response.ok) {
    throw new ForReportExcelError(`No se pudo descargar la plantilla oficial de FOR-AUD-AMB (HTTP ${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function generateForReportExcelBuffer(report, drive) {
  const templatePath = process.env.FOR_REPORT_EXCEL_TEMPLATE_PATH?.trim();
  if (!templatePath) {
    throw new ForReportExcelError('Falta configurar FOR_REPORT_EXCEL_TEMPLATE_PATH en el archivo .env.');
  }
  let templateBuffer;
  try {
    templateBuffer = await loadTemplateBuffer(templatePath);
  } catch (error) {
    throw new ForReportExcelError('No se pudo leer la plantilla oficial de FOR-AUD-AMB.', error);
  }
  const templateWorkbook = new ExcelJS.Workbook();
  try {
    await templateWorkbook.xlsx.load(templateBuffer);
  } catch (error) {
    throw new ForReportExcelError('La plantilla oficial no es un libro Excel válido.', error);
  }
  const markerLocations = validateWorkbook(templateWorkbook);
  const { values, evidence } = buildReportValues(report);
  const replacementsByCell = new Map();
  for (const [marker, replacement] of values) {
    const location = markerLocations.get(marker)?.[0];
    if (!location) throw new ForReportExcelError(`No se encontró el marcador ${marker}.`);
    const cellValues = replacementsByCell.get(location.sheetName) || new Map();
    cellValues.set(location.address, replacement);
    replacementsByCell.set(location.sheetName, cellValues);
  }
  const zip = await JSZip.loadAsync(templateBuffer);
  const sheetFiles = await getSheetFiles(zip);
  await replaceWorkbookMarkers(zip, markerLocations, values, sheetFiles);
  const worksheetRelationshipsPath = path.posix.join(
    path.posix.dirname(sheetFiles.get('EVIDENCIA')),
    '_rels',
    `${path.posix.basename(sheetFiles.get('EVIDENCIA'))}.rels`,
  );
  const worksheetRelationships = await zip.file(worksheetRelationshipsPath)?.async('string');
  const drawingRelationship = [...(worksheetRelationships || '').matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => getAttributes(match[1]))
    .find((attrs) => attrs.Type?.endsWith('/drawing'));
  const drawingPath = drawingRelationship ? getRelationshipTargetPath(worksheetRelationshipsPath, drawingRelationship.Target) : '';
  if (!drawingPath) throw new ForReportExcelError('No se localizó el dibujo de la hoja EVIDENCIA.');
  const excelEvidenceSheet = templateWorkbook.getWorksheet('EVIDENCIA');
  await insertEvidencePictures({
    zip,
    drive,
    report,
    evidence,
    markerLocations,
    worksheet: excelEvidenceSheet,
    sheetFiles,
  });
  await hideUnusedEvidenceColumns({ zip, evidence, markerLocations, sheetFiles });
  await hideNotApplicableCategoryRows({
    zip,
    markerLocations,
    sheetFiles,
    notApplicableCategories: report.notApplicableCategories || [],
  });
  const outputBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const expectedImageCount = evidence.reduce((total, item) => total + (item?.images.length || 0), 0);
  await verifyGeneratedWorkbook(outputBuffer, replacementsByCell, expectedImageCount, await JSZip.loadAsync(templateBuffer));
  return {
    buffer: outputBuffer,
    templateVersion: TEMPLATE_VERSION,
    imageCount: expectedImageCount,
    fileName: `${report.reportId}-rev-${report.revision}.xlsx`,
    downloadFileName: buildDownloadFileName(report),
  };
}

module.exports = {
  DEFAULT_TEMPLATE_PATH,
  ForReportExcelError,
  TEMPLATE_VERSION,
  buildDownloadFileName,
  buildReportValues,
  generateForReportExcelBuffer,
  markerInventory,
  validateWorkbook,
  verifyGeneratedWorkbook,
};
