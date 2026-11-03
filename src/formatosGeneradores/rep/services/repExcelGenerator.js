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
  const month = new Intl.DateTimeFormat('es-MX', { month: 'long', timeZone: 'UTC' }).format(dateObject);
  const year = date.slice(0, 4);
  const start = report.generalData.startTime;
  const end = report.generalData.endTime;
  const company = report.agencyLegalNameSnapshot || report.agencyNameSnapshot;
  const branch = report.agencyNameSnapshot;
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
    ['fecha_recorrido', formatDate(date)],
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

function findingValues(finding, index, report) {
  return new Map([
    ['fecha_recorrido', formatDate(report.generalData.inspectionDate)],
    ['direccion', report.agencyAddressSnapshot || ''],
    ['area', finding.area],
    ['n', index + 1],
    ['elemento_revisado', finding.element],
    ['descripcion', finding.description],
    ['numero_imagen', finding.imageNumber],
    ['prioridad', finding.priority],
    ['responsable', finding.responsible],
    ['fundamento_legal', finding.legalBasis],
    ['fecha_hallazgo', formatDate(finding.findingDate)],
    ['fecha_cumplimiento', formatDate(finding.dueDate)],
    ['status', finding.status],
    ['en_tiempo', finding.onTime],
    ['sancion', finding.sanction],
  ]);
}

function applyFindingRows(worksheet, findings, report) {
  if (!findings.length) {
    worksheet.spliceRows(REVIEW_ROW, 1);
    const totalRow = worksheet.getRow(REVIEW_ROW);
    totalRow.getCell(20).value = 0;
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
        const sanction = findings[index].sanction;
        cell.value = sanction === '' || sanction === undefined || sanction === null ? null : Number(sanction);
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
  totalCell.value = { formula: `SUM(T${REVIEW_ROW}:T${REVIEW_ROW + findings.length - 1})` };
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

function buildDownloadFileName(report) {
  const period = report.generalData.inspectionDate;
  return `REP-INS-${report.reportId.replace(/^REP-/i, '')}-rev-${report.revision}-${period}.xlsx`;
}

async function generateRepExcelBuffer(report, { logoBuffer, logoMimeType }) {
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
  const { mainSheet, documentSheet } = validateTemplate(workbook);
  const generalValues = buildGeneralValues(report);
  const areasCell = mainSheet.getCell('K3');
  if (typeof areasCell.value === 'string') {
    areasCell.value = `${areasCell.value}${report.generalData.areas || ''}`;
  }
  mainSheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.number === REVIEW_ROW) return;
    row.eachCell({ includeEmpty: false }, (cell) => replaceCellMarkers(cell, generalValues));
  });
  applyFindingRows(mainSheet, report.findings, report);
  applyDocumentValues(documentSheet, report.documents || {}, generalValues);

  let serializedWorkbook;
  try {
    serializedWorkbook = Buffer.from(await workbook.xlsx.writeBuffer());
  } catch (error) {
    throw new RepExcelError('No se pudo transformar la plantilla REP.', error);
  }
  const zip = await JSZip.loadAsync(serializedWorkbook);
  let outputBuffer;
  try {
    outputBuffer = await zip.generateAsync({
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
    downloadFileName: buildDownloadFileName(report),
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
