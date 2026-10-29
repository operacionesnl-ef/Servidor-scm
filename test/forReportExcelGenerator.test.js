'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const {
  DEFAULT_TEMPLATE_PATH,
  ForReportExcelError,
  generateForReportExcelBuffer,
  markerInventory,
  validateWorkbook,
} = require('../src/services/forReportExcelGenerator');

const REPORT_ID = 'FOR-12345678-1234-1234-1234-123456789012';

function makeReport(overrides = {}) {
  return {
    reportId: REPORT_ID,
    revision: 3,
    agencyNameSnapshot: 'Sucursal Norte',
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

  assert.equal(generated.imageCount, 1);
  assert.equal(evidenceSheet.getCell('A1').value, 'Evidencia 1');
  assert.equal(evidenceSheet.getCell('A22').value, 'Foto de inspección');
  assert.equal((drawingXml.match(/<xdr:sp>/g) || []).length, 3);
  assert.equal((drawingXml.match(/<xdr:pic>/g) || []).length, 1);
});

test('rejects invalid inspection dates before creating a workbook', async () => {
  await assert.rejects(
    generateForReportExcelBuffer(makeReport({
      generalData: { ...makeReport().generalData, inspectionDate: '2026-02-30' },
    }), null),
    (error) => error instanceof ForReportExcelError && /fecha del recorrido/i.test(error.message),
  );
});
