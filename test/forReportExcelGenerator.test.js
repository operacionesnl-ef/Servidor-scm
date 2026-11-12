'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const { ASPECTS } = require('../src/formatosGeneradores/for/formats/forAudAmb');
const {
  DEFAULT_TEMPLATE_PATH,
  ForReportExcelError,
  generateForReportExcelBuffer,
  markerInventory,
  validateWorkbook,
} = require('../src/formatosGeneradores/for/services/forReportExcelGenerator');

process.env.FOR_REPORT_EXCEL_TEMPLATE_PATH = DEFAULT_TEMPLATE_PATH;
const REPORT_ID = 'FOR-12345678-1234-1234-1234-123456789012';

function makeReport(overrides = {}) {
  return {
    reportId: REPORT_ID,
    revision: 3,
    agencyNameSnapshot: 'Sucursal Norte',
    agencyBrandSnapshot: 'HYUNDAI',
    generalData: {
      companyName: 'Sucursal Norte',
      legalName: 'Empresa Norte',
      inspectionDate: '2026-10-29',
      visitNumber: 4,
      observations: '',
    },
    environmentalAspects: [],
    evidence: [],
    ...overrides,
  };
}

test('validates every marker from the official workbook and replaces data without changing sheets', async () => {
  const source = await fs.readFile(DEFAULT_TEMPLATE_PATH);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(source);
  const markers = validateWorkbook(workbook);

  assert.equal(markers.size, markerInventory().size);
  assert.equal(markers.get('{imagen1}')[0].sheetName, 'EVIDENCIA');
  assert.equal(markers.get('{a1}')[0].sheetName, 'APLICA');

  const generated = await generateForReportExcelBuffer(makeReport(), null);
  const result = new ExcelJS.Workbook();
  await result.xlsx.load(generated.buffer);

  assert.deepEqual(result.worksheets.map((sheet) => sheet.name), ['DATOS', 'EVIDENCIA', 'APLICA']);
  assert.equal(result.getWorksheet('DATOS').getCell('B1').value, 'Empresa Norte · Sucursal Norte');
  assert.equal(result.getWorksheet('DATOS').getCell('B2').value, '29/10/2026');
  assert.equal(result.getWorksheet('DATOS').getCell('B3').value, 4);
  assert.equal(result.getWorksheet('DATOS').getCell('B4').value, '');
  assert.equal(result.getWorksheet('APLICA').getCell('C1').value, 'Sucursal Norte');
  assert.equal(result.getWorksheet('APLICA').getCell('C2').value, '');
  assert.equal(generated.imageCount, 0);
});

test('downloads a public Google Sheets template as an Excel workbook', async () => {
  const template = await fs.readFile(DEFAULT_TEMPLATE_PATH);
  const originalFetch = global.fetch;
  const originalTemplatePath = process.env.FOR_REPORT_EXCEL_TEMPLATE_PATH;
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, arrayBuffer: async () => template };
  };
  try {
    process.env.FOR_REPORT_EXCEL_TEMPLATE_PATH = 'https://docs.google.com/spreadsheets/d/example-sheet-id/edit?usp=drive_link';
    const generated = await generateForReportExcelBuffer(makeReport(), null);
    assert.equal(
      requestedUrl,
      'https://docs.google.com/spreadsheets/d/example-sheet-id/export?format=xlsx',
    );
    assert.ok(generated.buffer.length);
  } finally {
    global.fetch = originalFetch;
    process.env.FOR_REPORT_EXCEL_TEMPLATE_PATH = originalTemplatePath;
  }
});

test('preserves template shape graphics and inserts an evidence image into its marker area', async () => {
  const image = await sharp({
    create: { width: 240, height: 160, channels: 3, background: { r: 20, g: 120, b: 200 } },
  }).jpeg().toBuffer();
  const report = makeReport({
    evidence: [{
      evidenceId: 'evidence-12345678',
      description: 'Foto de inspección',
      status: 'active',
      images: [{ imageId: 'image-12345678', status: 'active', driveFileId: 'drive-image-1' }],
    }],
  });
  const drive = {
    files: {
      get: async () => ({ data: Readable.from([image]) }),
    },
  };

  const generated = await generateForReportExcelBuffer(report, drive);
  const zip = await JSZip.loadAsync(generated.buffer);
  const excel = new ExcelJS.Workbook();
  await excel.xlsx.load(generated.buffer);
  const evidenceSheet = excel.getWorksheet('EVIDENCIA');
  const drawingRelationship = await zip.file('xl/worksheets/_rels/sheet2.xml.rels').async('string');
  const drawingPath = drawingRelationship.match(/Target="([^"]+)"/)[1];
  const drawingFile = `xl/${drawingPath.replace(/^\.\.\//, '')}`;
  const drawingXml = await zip.file(drawingFile).async('string');
  const pictureAnchor = drawingXml.match(/<xdr:twoCellAnchor\b[\s\S]*?<xdr:pic>[\s\S]*?<\/xdr:twoCellAnchor>/)?.[0];
  const templateZip = await JSZip.loadAsync(await fs.readFile(DEFAULT_TEMPLATE_PATH));
  const templateDrawingXml = await templateZip.file(drawingFile).async('string');

  assert.equal(generated.imageCount, 1);
  assert.equal(evidenceSheet.getImages().length, 1);
  assert.equal(evidenceSheet.getCell('A1').value, 'Evidencia 1');
  assert.equal(evidenceSheet.getCell('A22').value, 'Foto de inspección');
  assert.equal(
    (drawingXml.match(/<xdr:sp>/g) || []).length,
    (templateDrawingXml.match(/<xdr:sp>/g) || []).length,
  );
  assert.equal((drawingXml.match(/<xdr:pic>/g) || []).length, 1);
  assert.match(
    drawingXml.match(/<a:blip\b[^>]*>/)?.[0] || '',
    /xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/,
  );
  assert.ok(pictureAnchor);
  const from = pictureAnchor.match(/<xdr:from>([\s\S]*?)<\/xdr:from>/)?.[1] || '';
  const to = pictureAnchor.match(/<xdr:to>([\s\S]*?)<\/xdr:to>/)?.[1] || '';
  const fromColumn = Number(from.match(/<xdr:col>(\d+)<\/xdr:col>/)?.[1]);
  const fromRow = Number(from.match(/<xdr:row>(\d+)<\/xdr:row>/)?.[1]);
  const toColumn = Number(to.match(/<xdr:col>(\d+)<\/xdr:col>/)?.[1]);
  const toRow = Number(to.match(/<xdr:row>(\d+)<\/xdr:row>/)?.[1]);
  assert.ok(fromColumn >= 0 && fromColumn < 5);
  assert.ok(fromRow >= 1 && fromRow < 21);
  assert.ok(toColumn > fromColumn && toColumn <= 5);
  assert.ok(toRow > fromRow && toRow <= 21);
  assert.equal(evidenceSheet.getColumn(1).hidden, false);
  assert.equal(evidenceSheet.getColumn(7).hidden, true);
});

test('embeds every Drive photo and anchors evidence one and two in their own merged blocks', async () => {
  const imageBuffers = await Promise.all([
    { width: 240, height: 160 },
    { width: 120, height: 200 },
    { width: 200, height: 100 },
    { width: 100, height: 100 },
    { width: 180, height: 120 },
  ].map(({ width, height }, index) => sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30 + index * 20, g: 100, b: 170 },
    },
  }).png().toBuffer()));
  const imageById = new Map(imageBuffers.map((buffer, index) => [`drive-image-${index + 1}`, buffer]));
  const generated = await generateForReportExcelBuffer(makeReport({
    evidence: [
      {
        evidenceId: 'evidence-one',
        description: 'Primer bloque',
        status: 'active',
        images: imageBuffers.slice(0, 4).map((_, index) => ({
          imageId: `image-one-${index + 1}`,
          status: 'active',
          driveFileId: `drive-image-${index + 1}`,
        })),
      },
      {
        evidenceId: 'evidence-two',
        description: 'Segundo bloque',
        status: 'active',
        images: [{
          imageId: 'image-two-1',
          status: 'active',
          driveFileId: 'drive-image-5',
        }],
      },
    ],
  }), {
    files: {
      get: async ({ fileId }) => ({ data: Readable.from([imageById.get(fileId)]) }),
    },
  });
  const zip = await JSZip.loadAsync(generated.buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(generated.buffer);
  const evidenceSheet = workbook.getWorksheet('EVIDENCIA');
  const drawingRelationships = await zip.file('xl/worksheets/_rels/sheet2.xml.rels').async('string');
  const drawingPath = `xl/${drawingRelationships.match(/Target="([^"]+)"/)[1].replace(/^\.\.\//, '')}`;
  const drawingXml = await zip.file(drawingPath).async('string');
  const imageAnchors = [...drawingXml.matchAll(/<xdr:twoCellAnchor\b[\s\S]*?<xdr:pic>[\s\S]*?<\/xdr:twoCellAnchor>/g)]
    .map(([anchor]) => {
      const from = anchor.match(/<xdr:from>([\s\S]*?)<\/xdr:from>/)?.[1] || '';
      const to = anchor.match(/<xdr:to>([\s\S]*?)<\/xdr:to>/)?.[1] || '';
      return {
        fromColumn: Number(from.match(/<xdr:col>(\d+)<\/xdr:col>/)?.[1]),
        fromRow: Number(from.match(/<xdr:row>(\d+)<\/xdr:row>/)?.[1]),
        toColumn: Number(to.match(/<xdr:col>(\d+)<\/xdr:col>/)?.[1]),
        toRow: Number(to.match(/<xdr:row>(\d+)<\/xdr:row>/)?.[1]),
      };
    });

  assert.equal(generated.imageCount, 5);
  assert.equal(evidenceSheet.getImages().length, 5);
  assert.equal(imageAnchors.length, 5);
  imageAnchors.slice(0, 4).forEach(({ fromColumn, fromRow, toColumn, toRow }) => {
    assert.ok(fromColumn >= 0 && fromColumn < 5);
    assert.ok(fromRow >= 1 && fromRow < 21);
    assert.ok(toColumn > fromColumn && toColumn <= 5);
    assert.ok(toRow > fromRow && toRow <= 21);
  });
  const secondBlock = imageAnchors[4];
  assert.ok(secondBlock.fromColumn >= 6 && secondBlock.fromColumn < 11);
  assert.ok(secondBlock.toColumn > secondBlock.fromColumn && secondBlock.toColumn <= 11);
  const imageParts = Object.keys(zip.files).filter((name) => /^xl\/media\/image\d+\.png$/.test(name));
  assert.equal(imageParts.length, 5);
});

test('rejects invalid inspection dates before creating a workbook', async () => {
  await assert.rejects(
    generateForReportExcelBuffer(makeReport({
      generalData: { ...makeReport().generalData, inspectionDate: '2026-02-30' },
    }), null),
    (error) => error instanceof ForReportExcelError && /fecha del recorrido/i.test(error.message),
  );
});

test('writes 0 and 1 as numeric cells in APLICA and leaves NA as text', async () => {
  const environmentalAspects = ASPECTS.slice(0, 3).map((aspect, index) => ({
    categoryId: aspect.categoryId,
    aspectId: aspect.id,
    answer: ['1', '0', 'NA'][index],
    observation: '',
  }));
  const generated = await generateForReportExcelBuffer(makeReport({ environmentalAspects }), null);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(generated.buffer);
  const applies = workbook.getWorksheet('APLICA');

  assert.equal(applies.getCell('C2').value, 1);
  assert.equal(typeof applies.getCell('C2').value, 'number');
  assert.equal(applies.getCell('C3').value, 0);
  assert.equal(typeof applies.getCell('C3').value, 'number');
  assert.equal(applies.getCell('C4').value, 'NA');
});

test('hides the columns for every unused evidence block', async () => {
  const generated = await generateForReportExcelBuffer(makeReport(), null);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(generated.buffer);
  const evidence = workbook.getWorksheet('EVIDENCIA');

  for (let index = 0; index < 20; index += 1) {
    const firstColumn = 1 + index * 6;
    for (let offset = 0; offset < 5; offset += 1) {
      assert.equal(evidence.getColumn(firstColumn + offset).hidden, true, `block ${index + 1}, column ${firstColumn + offset}`);
    }
    if (index < 19) {
      assert.equal(evidence.getColumn(firstColumn + 5).hidden, true, `separator after block ${index + 1}`);
    }
  }
});

test('hides only explicitly non-applicable sections and builds the requested download name', async () => {
  const generated = await generateForReportExcelBuffer(makeReport({
    agencyFileNameCodeSnapshot: 'HYN-SAN-NL',
    notApplicableCategories: ['taller'],
  }), null);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(generated.buffer);
  const applies = workbook.getWorksheet('APLICA');

  assert.equal(applies.getRow(31).hidden, true);
  assert.equal(applies.getRow(36).hidden, true);
  assert.equal(applies.getRow(30).hidden, false);
  assert.equal(applies.getRow(37).hidden, false);
  assert.equal(
    generated.downloadFileName,
    'FOR-AUD-AMB-HYN-SAN-NL-(29-10-2026)-(29-11-2026).xlsx',
  );
  const twoMonthReport = await generateForReportExcelBuffer(makeReport({
    agencyFileNameCodeSnapshot: 'ALT-DEL-CUU',
    reviewIntervalMonths: 2,
    agencyPeriod: '2026-10',
  }), null);
  assert.equal(
    twoMonthReport.downloadFileName,
    'FOR-AUD-AMB-ALT-DEL-CUU-(29-10-2026)-(29-12-2026).xlsx',
  );
});
