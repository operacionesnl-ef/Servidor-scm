'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const {
  DOCUMENT_MARKERS,
  FINDING_MARKERS,
  GENERAL_MARKERS,
  REVIEW_ROW,
} = require('../formats/repFormat');

const TEMPLATE_VERSION = '1.0';
const DEFAULT_TEMPLATE_PATH = path.join(__dirname, '../templates/REP-INS.xlsx');
const SHEETS = ['REPORTE REVISION PISO', 'REVISION DOCUMENTAL'];
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class RepExcelError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'RepExcelError';
  }
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (value && Array.isArray(value.richText)) return value.richText.map(({ text }) => text).join('');
  return '';
}

function findCellMarkers(workbook) {
  const found = [];
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.address !== cell.master.address) return;
        const text = extractText(cell.value);
        for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
          found.push({ marker: match[1], worksheet, address: cell.address, row: row.number, column: cell.col });
        }
      });
    });
  }
  return found;
}

function validateTemplate(workbook) {
  const missingSheets = SHEETS.filter((name) => !workbook.getWorksheet(name));
  if (missingSheets.length) {
    throw new RepExcelError(`La plantilla REP no contiene las hojas requeridas: ${missingSheets.join(', ')}.`);
  }
  const found = findCellMarkers(workbook);
  const mainSheet = workbook.getWorksheet(SHEETS[0]);
  const documentSheet = workbook.getWorksheet(SHEETS[1]);
  const rowMarkers = found.filter((entry) => entry.worksheet === mainSheet && entry.row === REVIEW_ROW);
  const missing = [
    ...GENERAL_MARKERS
      .filter((marker) => marker !== 'hora_inicio')
      .filter((marker) => !found.some((entry) => entry.marker === marker)),
    ...DOCUMENT_MARKERS.filter((marker) => !found.some((entry) => entry.marker === marker)),
    ...FINDING_MARKERS.filter((marker) => !rowMarkers.some((entry) => entry.marker === marker)),
  ];
  const actions = rowMarkers.filter(({ marker }) => marker === 'accion');
  if (actions.length !== 2) {
    throw new RepExcelError('La fila 5 de la plantilla debe contener dos marcadores {accion}, uno correctivo y otro preventivo.');
  }
  const unknown = found
    .map(({ marker }) => marker)
    .filter((marker) => ![...GENERAL_MARKERS, ...DOCUMENT_MARKERS, ...FINDING_MARKERS].includes(marker));
  if (missing.length || unknown.length) {
    throw new RepExcelError([
      missing.length ? `faltan marcadores ${[...new Set(missing)].join(', ')}` : '',
      unknown.length ? `no se reconocen marcadores ${[...new Set(unknown)].join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
  if (!documentSheet.getCell('B3').isMerged && !documentSheet.model.merges.includes('B3:G3')) {
    throw new RepExcelError('La hoja REVISION DOCUMENTAL no conserva el encabezado combinado B3:G3.');
  }
  return { found, mainSheet, documentSheet };
}

function formatDate(value) {
  if (!value) return '';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function buildGeneralValues(report) {
  const date = report.generalData.inspectionDate;
  const dateObject = new Date(`${date}T00:00:00.000Z`);
  const month = new Intl.DateTimeFormat('es-MX', { month: 'long', timeZone: 'UTC' }).format(dateObject).toLocaleUpperCase('es-MX');
  const year = date.slice(0, 4);
  const start = report.generalData.startTime;
  const end = report.generalData.endTime;
  const company = (report.agencyLegalNameSnapshot || report.agencyNameSnapshot).toLocaleUpperCase('es-MX');
  const branch = (report.agencyNameSnapshot || '').toLocaleUpperCase('es-MX');
  const startText = [formatDate(report.generalData.startDate || date), start].filter(Boolean).join(' ');
  const endText = [formatDate(report.generalData.endDate || date), end].filter(Boolean).join(' ');
  return new Map([
    ['razon_social', company],
    ['sucursal', branch],
    ['direccion', report.agencyAddressSnapshot || ''],
    ['tipo_recorrido_or', report.generalData.visitType === 'ordinario' ? 'X' : ''],
    ['tipo_recorrido_ext', report.generalData.visitType === 'extraordinario' ? 'X' : ''],
    ['mes', month],
    ['year', year],
    ['año', year],
    ['fecha_inicio', startText],
    ['hora_inicio', start],
    ['fecha_fin', endText],
    ['hora_fin', end],
    ['fecha_recorrido', formatDate(report.generalData.startDate || date)],
    ['areas', report.generalData.areas],
  ]);
}

function replaceTextMarkers(text, values) {
  const normalized = text.replace(/\{razon_social\}\s*\{sucursal\}/g, '{razon_social} - {sucursal}');
  return normalized.replace(/\{([^{}]+)\}/g, (marker, key) => (
    values.has(key) ? String(values.get(key) ?? '') : marker
  ));
}

function replaceCellMarkers(cell, values) {
  if (typeof cell.value === 'string') {
    cell.value = replaceTextMarkers(cell.value, values);
    return;
  }
  if (cell.value && Array.isArray(cell.value.richText)) {
    cell.value = {
      ...cell.value,
      richText: cell.value.richText.map((run) => ({
        ...run,
        text: replaceTextMarkers(run.text, values),
      })),
    };
  }
}

function decodeXmlText(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code[0] === '#') {
      const number = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return String.fromCodePoint(number);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()];
  });
}

function encodeXmlText(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[character]));
}

function readSharedStrings(xml) {
  const entries = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => (
    [...match[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXmlText(text[1]))
      .join('')
  ));
  const indexes = new Map(entries.map((text, index) => [text, index]));
  return { entries, indexes };
}

function appendSharedString(text, sharedStrings) {
  const normalized = String(text ?? '');
  if (sharedStrings.indexes.has(normalized)) return sharedStrings.indexes.get(normalized);
  const index = sharedStrings.entries.length;
  sharedStrings.entries.push(normalized);
  sharedStrings.indexes.set(normalized, index);
  sharedStrings.additions.push(`<si><t xml:space="preserve">${encodeXmlText(normalized)}</t></si>`);
  return index;
}

function buildSharedStringsXml(templateXml, sharedStrings, referenceCount) {
  let xml = templateXml.replace('</sst>', `${sharedStrings.additions.join('')}</sst>`);
  xml = xml.replace(/\bcount="\d+"/, `count="${referenceCount}"`);
  xml = xml.replace(/\buniqueCount="\d+"/, `uniqueCount="${sharedStrings.entries.length}"`);
  return xml;
}

function getCellString(cellXml, sharedStrings) {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1];
  if (type === 's') {
    const index = Number(cellXml.match(/<v>(\d+)<\/v>/)?.[1]);
    return sharedStrings.entries[index] ?? '';
  }
  if (type === 'inlineStr') {
    return [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXmlText(match[1]))
      .join('');
  }
  return '';
}

function writeCellXml(cellXml, value, sharedStrings) {
  const opening = cellXml.match(/^<c\b([^>]*)/);
  if (!opening) return cellXml;
  const attributes = opening[1].replace(/\s+t="[^"]*"/g, '').replace(/\/\s*$/, '');
  if (typeof value === 'number') return `<c${attributes}><v>${value}</v></c>`;
  const index = appendSharedString(value, sharedStrings);
  return `<c${attributes} t="s"><v>${index}</v></c>`;
}

function writeFormulaCellXml(cellXml, formula) {
  const opening = cellXml.match(/^<c\b([^>]*)/);
  if (!opening) return cellXml;
  const attributes = opening[1].replace(/\s+t="[^"]*"/g, '').replace(/\/\s*$/, '');
  return `<c${attributes}><f>${encodeXmlText(formula)}</f><v>0</v></c>`;
}

function replaceRowCell(rowXml, address, value, sharedStrings, formula = false) {
  let found = false;
  const updated = rowXml.replace(/<c\b[^>]*?\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
    if (cellXml.match(/\br="([^"]+)"/)?.[1] !== address) return cellXml;
    found = true;
    return formula
      ? writeFormulaCellXml(cellXml, value)
      : writeCellXml(cellXml, value, sharedStrings);
  });
  if (!found) throw new RepExcelError(`No se encontró la celda ${address} en la plantilla REP.`);
  return updated;
}

function markerValuesForRow(rowXml, sharedStrings, values) {
  let actionIndex = 0;
  return rowXml.replace(/<c\b[^>]*?\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
    const text = getCellString(cellXml, sharedStrings);
    if (!text.includes('{')) return cellXml;
    const exactMarker = text.match(/^\{([^{}]+)\}$/)?.[1];
    if (exactMarker === 'n' || exactMarker === 'sancion') {
      const value = values.get(exactMarker);
      return writeCellXml(cellXml, value === undefined ? '' : value, sharedStrings);
    }
    if (exactMarker === 'accion') {
      const value = values.get(`accion${actionIndex}`);
      actionIndex += 1;
      return writeCellXml(cellXml, value || '', sharedStrings);
    }
    const replaced = replaceTextMarkers(text, values);
    return replaced === text ? cellXml : writeCellXml(cellXml, replaced, sharedStrings);
  });
}

function replaceRowNumber(rowXml, rowNumber) {
  return rowXml
    .replace(/(<row\b[^>]*\br=")\d+(")/, `$1${rowNumber}$2`)
    .replace(/(<c\b[^>]*\br="[A-Z]+)\d+(")/g, `$1${rowNumber}$2`);
}

function shiftRowReferences(rowXml, delta) {
  if (!delta) return rowXml;
  const shifted = rowXml.replace(/(<f\b[^>]*>)([\s\S]*?)(<\/f>)/g, (formula, open, value, close) => (
    `${open}${value.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (reference, column, row) => (
      Number(row) >= 6 ? `${column}${Number(row) + delta}` : reference
    ))}${close}`
  ));
  const rowNumber = Number(shifted.match(/<row\b[^>]*\br="(\d+)"/)?.[1]);
  return replaceRowNumber(shifted, rowNumber + delta);
}

function shiftWorksheetRanges(xml, delta) {
  if (!delta) return xml;
  return xml.replace(/\b(?:ref|sqref)="([^"]+)"/g, (attribute, range) => (
    attribute.replace(range, range.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (reference, column, row) => (
      Number(row) >= 6 ? `${column}${Number(row) + delta}` : reference
    )))
  ));
}

function writeFindingRow(rowXml, rowNumber, finding, index, report, sharedStrings) {
  let result = replaceRowNumber(rowXml, rowNumber);
  const values = findingValues(finding, index, report);
  values.set('accion0', finding.correctiveAction);
  values.set('accion1', finding.preventiveAction);
  result = markerValuesForRow(result, sharedStrings, values);
  result = replaceRowCell(result, `A${rowNumber}`, report.agencyNameSnapshot || '', sharedStrings);
  result = replaceRowCell(result, `B${rowNumber}`, report.generalData.city || '', sharedStrings);
  return replaceRowCell(result, `C${rowNumber}`, report.agencyStateSnapshot || '', sharedStrings);
}

function writeFindingsToWorksheet(xml, findings, report, sharedStrings) {
  const rowMatches = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g)];
  const templateFindingRow = rowMatches.find((match) => Number(match[1]) === REVIEW_ROW)?.[0];
  const totalRow = rowMatches.find((match) => Number(match[1]) === REVIEW_ROW + 1)?.[0];
  if (!templateFindingRow || !totalRow) {
    throw new RepExcelError('La hoja REP no contiene la fila 5 de hallazgos y su fila de monto acumulado.');
  }
  const shift = Math.max(0, findings.length - 1);
  let firstFindingRow;
  const insertedFindingRows = [];
  if (!findings.length) {
    const emptyValues = new Map([...FINDING_MARKERS, ...GENERAL_MARKERS, ...DOCUMENT_MARKERS, 'fecha_recorrido']
      .map((marker) => [marker, '']));
    emptyValues.set('n', '');
    emptyValues.set('sancion', '');
    emptyValues.set('accion0', '');
    emptyValues.set('accion1', '');
    firstFindingRow = markerValuesForRow(templateFindingRow, sharedStrings, emptyValues);
  } else {
    firstFindingRow = writeFindingRow(templateFindingRow, REVIEW_ROW, findings[0], 0, report, sharedStrings);
    for (let index = 1; index < findings.length; index += 1) {
      insertedFindingRows.push(writeFindingRow(
        templateFindingRow,
        REVIEW_ROW + index,
        findings[index],
        index,
        report,
        sharedStrings,
      ));
    }
  }
  const totalRowNumber = REVIEW_ROW + 1 + shift;
  let outputTotalRow = replaceRowNumber(totalRow, totalRowNumber);
  outputTotalRow = replaceRowCell(outputTotalRow, `T${totalRowNumber}`, findings.length * 16000, sharedStrings);
  let updated = xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g, (rowXml, number) => {
    const rowNumber = Number(number);
    if (rowNumber === REVIEW_ROW) return firstFindingRow;
    if (rowNumber === REVIEW_ROW + 1) return `${insertedFindingRows.join('')}${outputTotalRow}`;
    const nextRow = rowNumber > REVIEW_ROW + 1 ? shiftRowReferences(rowXml, shift) : rowXml;
    return nextRow;
  });
  return shiftWorksheetRanges(updated, shift);
}

function writeGeneralValuesToWorksheet(xml, sharedStrings, values, skipFindingRow = false) {
  return xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g, (rowXml, row) => {
    if (skipFindingRow && Number(row) === REVIEW_ROW) return rowXml;
    return markerValuesForRow(rowXml, sharedStrings, values);
  });
}

function updateTableRange(xml, findingCount) {
  const lastDataRow = Math.max(REVIEW_ROW, REVIEW_ROW - 1 + findingCount);
  return xml.replace(/\bref="A4:Z\d+"/, `ref="A4:Z${lastDataRow}"`);
}

async function removeCalcChain(zip) {
  zip.remove('xl/calcChain.xml');
  const relationshipsPath = 'xl/_rels/workbook.xml.rels';
  const relationships = await zip.file(relationshipsPath)?.async('string');
  if (relationships) {
    zip.file(relationshipsPath, relationships.replace(
      /<Relationship\b(?=[^>]*\/calcChain")[^>]*\/>/g,
      '',
    ));
  }
  const contentTypesPath = '[Content_Types].xml';
  const contentTypes = await zip.file(contentTypesPath)?.async('string');
  if (contentTypes) {
    zip.file(contentTypesPath, contentTypes.replace(
      /<Override\b(?=[^>]*\/xl\/calcChain\.xml")[^>]*\/>/g,
      '',
    ));
  }
}

function updateWorksheetCell(xml, address, value, sharedStrings) {
  const rowNumber = Number(address.match(/\d+$/)?.[0]);
  const rowPattern = new RegExp(`<row\\b[^>]*\\br="${rowNumber}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/row>)`);
  return xml.replace(rowPattern, (rowXml) => replaceRowCell(rowXml, address, value, sharedStrings));
}

function findingValues(finding, index, report) {
  return new Map([
    ['fecha_recorrido', formatDate(report.generalData.startDate || report.generalData.inspectionDate)],
    ['direccion', report.agencyAddressSnapshot || ''],
    ['area', finding.area],
    ['n', index + 1],
    ['elemento_revisado', finding.element],
    ['descripcion', finding.description],
    ['numero_imagen', finding.imageNumber ? `Imagen ${index + 1}` : ''],
    ['prioridad', finding.priority],
    ['responsable', finding.responsible],
    ['fundamento_legal', finding.legalBasis],
    ['fecha_hallazgo', formatDate(finding.findingDate)],
    ['fecha_cumplimiento', formatDate(finding.dueDate)],
    ['status', finding.status],
    ['en_tiempo', finding.onTime],
    ['sancion', 16000],
  ]);
}

function applyFindingRows(worksheet, findings, report) {
  if (!findings.length) {
    const emptyValues = new Map([...FINDING_MARKERS, ...GENERAL_MARKERS, ...DOCUMENT_MARKERS, 'fecha_recorrido']
      .map((marker) => [marker, '']));
    const findingRow = worksheet.getRow(REVIEW_ROW);
    findingRow.eachCell({ includeEmpty: false }, (cell) => replaceCellMarkers(cell, emptyValues));
    worksheet.getRow(REVIEW_ROW + 1).getCell(20).value = 0;
    return;
  }
  if (findings.length > 1) worksheet.duplicateRow(REVIEW_ROW, findings.length - 1, true);
  for (let index = 0; index < findings.length; index += 1) {
    const row = worksheet.getRow(REVIEW_ROW + index);
    const values = findingValues(findings[index], index, report);
    row.getCell(1).value = report.agencyNameSnapshot;
    row.getCell(2).value = report.generalData.city || '';
    row.getCell(3).value = report.agencyStateSnapshot || '';
    let actionCount = 0;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = extractText(cell.value);
      if (text === '{n}') {
        cell.value = index + 1;
        return;
      }
      if (text === '{sancion}') {
        cell.value = 16000;
        return;
      }
      if (text === '{accion}') {
        values.set('accion', actionCount === 0
          ? findings[index].correctiveAction
          : findings[index].preventiveAction);
        actionCount += 1;
      }
      replaceCellMarkers(cell, values);
    });
  }
  const totalRowIndex = REVIEW_ROW + findings.length;
  const totalCell = worksheet.getRow(totalRowIndex).getCell(20);
  totalCell.value = { formula: `COUNT(A${REVIEW_ROW}:A${REVIEW_ROW + findings.length - 1})*16000` };
}

function applyDocumentValues(worksheet, documents, generalValues) {
  const values = new Map(DOCUMENT_MARKERS.map((key) => [key, documents[key] || '']));
  for (const [key, value] of generalValues) values.set(key, value);
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => replaceCellMarkers(cell, values));
  });
}

function getAttributes(value) {
  return Object.fromEntries([...value.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)]
    .map((match) => [match[1], match[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"')]));
}

function relationshipTargetPath(relationshipsPath, target) {
  return target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(path.posix.dirname(relationshipsPath)), target));
}

async function getSheetFiles(zip) {
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbookXml || !relationshipsXml) throw new RepExcelError('La plantilla no contiene relaciones de hojas válidas.');
  const relations = new Map([...relationshipsXml.matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => {
      const attrs = getAttributes(match[1]);
      return [attrs.Id, attrs.Target];
    }));
  const sheets = new Map();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = getAttributes(match[1]);
    const target = relations.get(attrs['r:id']);
    if (target) sheets.set(attrs.name, relationshipTargetPath('xl/_rels/workbook.xml.rels', target));
  }
  return sheets;
}

async function replaceNamedLogo(zip, sheetPath, imageBuffer, imageMimeType) {
  const sheetRelationshipsPath = path.posix.join(
    path.posix.dirname(sheetPath),
    '_rels',
    `${path.posix.basename(sheetPath)}.rels`,
  );
  const sheetRelationships = await zip.file(sheetRelationshipsPath)?.async('string');
  const drawingRelation = [...String(sheetRelationships || '').matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => getAttributes(match[1]))
    .find(({ Type }) => Type?.endsWith('/drawing'));
  if (!drawingRelation) throw new RepExcelError('No se encontró el dibujo de la hoja de revisión de piso.');
  const drawingPath = relationshipTargetPath(sheetRelationshipsPath, drawingRelation.Target);
  const drawingRelationshipsPath = path.posix.join(
    path.posix.dirname(drawingPath),
    '_rels',
    `${path.posix.basename(drawingPath)}.rels`,
  );
  const drawingXml = await zip.file(drawingPath)?.async('string');
  const drawingRelationships = await zip.file(drawingRelationshipsPath)?.async('string');
  if (!drawingXml || !drawingRelationships) throw new RepExcelError('No se pudo leer el dibujo original del REP.');
  const logoPicture = [...drawingXml.matchAll(/<xdr:pic>[\s\S]*?<\/xdr:pic>/g)]
    .find((match) => /<xdr:cNvPr\b[^>]*\bname="logo"/.test(match[0]));
  if (!logoPicture) throw new RepExcelError('La plantilla no contiene una imagen identificada como logo.');
  const imageRelationshipId = logoPicture[0].match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
  const imageRelation = [...drawingRelationships.matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => getAttributes(match[1]))
    .find(({ Id }) => Id === imageRelationshipId);
  if (!imageRelation) throw new RepExcelError('El logo no tiene una relación válida en la plantilla.');
  const mediaPath = relationshipTargetPath(drawingRelationshipsPath, imageRelation.Target);
  const extension = path.posix.extname(mediaPath).toLowerCase();
  let converted;
  if (extension === '.png') converted = await sharp(imageBuffer).png().toBuffer();
  else if (extension === '.jpg' || extension === '.jpeg') converted = await sharp(imageBuffer).jpeg().toBuffer();
  else if (extension === '.webp') converted = await sharp(imageBuffer).webp().toBuffer();
  else throw new RepExcelError(`El formato de imagen ${imageMimeType} no puede reemplazar el logo de la plantilla.`);
  zip.file(mediaPath, converted);
}

function buildDownloadFileName(report, intervalMonths = 1) {
  const date = report.generalData.inspectionDate;
  const day = date.slice(8, 10);
  const month = date.slice(5, 7);
  const year = date.slice(0, 4);
  const parsedInterval = Number(intervalMonths);
  const interval = Number.isInteger(parsedInterval) && parsedInterval >= 1 && parsedInterval <= 120
    ? parsedInterval
    : 1;
  const endDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  endDate.setUTCMonth(endDate.getUTCMonth() + interval);
  if (endDate.getUTCDate() !== Number(day)) endDate.setUTCDate(0);
  const endToken = `(${String(endDate.getUTCDate()).padStart(2, '0')}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${endDate.getUTCFullYear()})`;
  const code = String(report.agencyFileNameCodeSnapshot || 'SIN-CODIGO')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'SIN-CODIGO';
  return `REP-INS-${code}-(${day}-${month}-${year})-${endToken}.xlsx`;
}

async function generateRepExcelBuffer(report, { logoBuffer, logoMimeType, intervalMonths = 1 }) {
  const templatePath = process.env.REP_EXCEL_TEMPLATE_PATH?.trim() || DEFAULT_TEMPLATE_PATH;
  let templateBuffer;
  try {
    templateBuffer = await fs.readFile(path.resolve(process.cwd(), templatePath));
  } catch (error) {
    throw new RepExcelError('No se pudo leer la plantilla REP configurada.', error);
  }
  if (!Buffer.isBuffer(logoBuffer) || !logoBuffer.length) {
    throw new RepExcelError(`No se encontró un logo de Drive para la marca ${report.agencyBrandSnapshot || '(sin marca)'}.`);
  }

  const templateZip = await JSZip.loadAsync(templateBuffer);
  const templateSheetFiles = await getSheetFiles(templateZip);
  await replaceNamedLogo(
    templateZip,
    templateSheetFiles.get(SHEETS[0]),
    logoBuffer,
    logoMimeType,
  );
  const preparedTemplate = await templateZip.generateAsync({ type: 'nodebuffer' });
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(preparedTemplate);
  } catch (error) {
    throw new RepExcelError('La plantilla REP no es un libro Excel válido.', error);
  }
  const { mainSheet } = validateTemplate(workbook);
  const generalValues = buildGeneralValues(report);
  const sharedStringsFile = templateZip.file('xl/sharedStrings.xml');
  if (!sharedStringsFile) throw new RepExcelError('La plantilla REP no contiene la tabla de cadenas compartidas.');
  const sharedStringsXml = await sharedStringsFile.async('string');
  const sharedStrings = { ...readSharedStrings(sharedStringsXml), additions: [] };
  const sheetPaths = [...templateSheetFiles.values()];
  const mainSheetPath = templateSheetFiles.get(SHEETS[0]);
  const documentSheetPath = templateSheetFiles.get(SHEETS[1]);
  let mainXml = await templateZip.file(mainSheetPath)?.async('string');
  let documentXml = await templateZip.file(documentSheetPath)?.async('string');
  if (!mainXml || !documentXml) throw new RepExcelError('No se pudieron leer las hojas de la plantilla REP.');
  mainXml = writeGeneralValuesToWorksheet(mainXml, sharedStrings, generalValues, true);
  const areasCell = mainSheet.getCell('K3');
  const areasText = extractText(areasCell.value);
  mainXml = updateWorksheetCell(
    mainXml,
    'K3',
    `${areasText}${report.generalData.areas || ''}`,
    sharedStrings,
  );
  mainXml = writeFindingsToWorksheet(mainXml, report.findings || [], report, sharedStrings);
  const documentValues = new Map([
    ...DOCUMENT_MARKERS.map((key) => [key, report.documents?.[key] || '']),
    ...generalValues,
  ]);
  documentXml = writeGeneralValuesToWorksheet(documentXml, sharedStrings, documentValues);
  templateZip.file(mainSheetPath, mainXml);
  templateZip.file(documentSheetPath, documentXml);

  const tableFile = templateZip.file('xl/tables/table1.xml');
  if (!tableFile) throw new RepExcelError('La plantilla REP no contiene su tabla de revisión.');
  templateZip.file('xl/tables/table1.xml', updateTableRange(
    await tableFile.async('string'),
    report.findings?.length || 0,
  ));
  let sharedStringReferences = 0;
  for (const sheetPath of sheetPaths) {
    const sheetXml = await templateZip.file(sheetPath)?.async('string');
    if (sheetXml) sharedStringReferences += [...sheetXml.matchAll(/\bt="s"/g)].length;
  }
  templateZip.file(
    'xl/sharedStrings.xml',
    buildSharedStringsXml(sharedStringsXml, sharedStrings, sharedStringReferences),
  );
  await removeCalcChain(templateZip);
  let outputBuffer;
  try {
    outputBuffer = await templateZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  } catch (error) {
    throw new RepExcelError('No se pudo exportar el libro REP.', error);
  }
  const verification = new ExcelJS.Workbook();
  try {
    await verification.xlsx.load(outputBuffer);
  } catch (error) {
    throw new RepExcelError('El REP generado no se puede abrir como un Excel válido.', error);
  }
  const pendingMarkers = findCellMarkers(verification);
  if (pendingMarkers.length) {
    throw new RepExcelError(`Quedaron marcadores sin resolver: ${pendingMarkers.slice(0, 20)
      .map(({ marker, worksheet, address }) => `${worksheet.name}!${address}={${marker}}`).join(', ')}.`);
  }
  if (verification.getWorksheet(SHEETS[0]).getImages().length !== mainSheet.getImages().length) {
    throw new RepExcelError('La validación detectó cambios inesperados en las imágenes de la plantilla.');
  }
  return {
    buffer: outputBuffer,
    templateVersion: TEMPLATE_VERSION,
    downloadFileName: buildDownloadFileName(report, intervalMonths),
  };
}

module.exports = {
  DEFAULT_TEMPLATE_PATH,
  RepExcelError,
  TEMPLATE_VERSION,
  buildDownloadFileName,
  generateRepExcelBuffer,
  validateTemplate,
};
