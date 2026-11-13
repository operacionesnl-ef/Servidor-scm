'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const templatePath = require('../src/formatosGeneradores/rep/services/repExcelGenerator').DEFAULT_TEMPLATE_PATH;
const {
  buildDownloadFileName,
  generateRepExcelBuffer,
  validateTemplate,
} = require('../src/formatosGeneradores/rep/services/repExcelGenerator');

process.env.REP_EXCEL_TEMPLATE_PATH = templatePath;

function makeReport(findings = [{}]) {
  return {
    reportId: 'REP-12345678-1234-1234-1234-123456789012',
    revision: 3,
    agencyNameSnapshot: 'Sucursal Norte',
    agencyLegalNameSnapshot: 'Empresa Norte',
    agencyAddressSnapshot: 'Calle Uno 123',
    agencyCitySnapshot: 'Monterrey',
    agencyStateSnapshot: 'Nuevo León',
    agencyBrandSnapshot: 'MARCA',
    agencyFileNameCodeSnapshot: 'HYU-SEN-NL',
    generalData: {
      inspectionDate: '2026-10-29',
      startDate: '2026-10-29',
      endDate: '2026-10-29',
      visitType: 'ordinario',
      startTime: '08:00',
      endTime: '10:00',
      areas: 'Patio y almacén',
    },
    findings: findings.map((finding) => ({
      area: 'Patio',
      element: 'Extintor',
      description: 'Sin etiqueta vigente',
      imageNumber: '1, 2',
      correctiveAction: 'Reponer etiqueta',
      preventiveAction: 'Inspección mensual',
      priority: 'alta',
      responsible: 'Ana',
      legalBasis: 'NOM aplicable',
      findingDate: '2026-10-29',
      dueDate: '2026-11-05',
      status: 'Pendiente',
      onTime: 'Sí',
      sanction: '0',
      ...finding,
    })),
    documents: {
      estudio_iluminacion: 'Cumple',
      estudio_ruido: 'Pendiente',
    },
  };
}

test('builds the REP workbook name with the agency code and FOR date convention', () => {
  const report = makeReport();
  assert.equal(
    buildDownloadFileName(report),
    'REP-INS-HYU-SEN-NL-(29-10-2026)-(29-11-2026).xlsx',
  );
});

test('builds the REP workbook name using the configured two-month security interval', () => {
  const report = makeReport();
  report.generalData.inspectionDate = '2026-09-01';
  assert.equal(
    buildDownloadFileName(report, 2),
    'REP-INS-HYU-SEN-NL-(01-09-2026)-(01-11-2026).xlsx',
  );
});

async function makeLogo() {
  return sharp({
    create: { width: 64, height: 32, channels: 4, background: { r: 230, g: 10, b: 10, alpha: 1 } },
  }).png().toBuffer();
}

test('validates the uploaded REP template sheets, markers, and duplicate action cells', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const result = validateTemplate(workbook);
  assert.equal(result.mainSheet.name, 'REPORTE REVISION PISO');
  assert.equal(result.documentSheet.name, 'REVISION DOCUMENTAL');
});

test('replaces agency and period markers from snapshots and the recorrido start date', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rep-template-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const tempTemplatePath = path.join(tempDir, 'REP-INS.xlsx');
  const template = new ExcelJS.Workbook();
  await template.xlsx.readFile(templatePath);
  const sheet = template.getWorksheet('REPORTE REVISION PISO');
  const markerCells = {
    AA1: '{ciudad}',
    AB1: '{estado}',
    AC1: '{semana}',
    AD1: '{year_mes}',
    AE1: '{year_semana}',
    AF1: '{marca}',
  };
  for (const [address, marker] of Object.entries(markerCells)) {
    sheet.getCell(address).value = marker;
  }
  await template.xlsx.writeFile(tempTemplatePath);
  const templateZip = await JSZip.loadAsync(await fs.readFile(tempTemplatePath));
  const drawingPath = 'xl/drawings/drawing1.xml';
  const drawing = await templateZip.file(drawingPath).async('string');
  const drawingWithLogo = drawing.replace(
    /(<xdr:pic>[\s\S]*?<xdr:cNvPr\b[^>]*\bname=")[^"]+(")/,
    '$1logo$2',
  );
  assert.notEqual(drawingWithLogo, drawing);
  templateZip.file(drawingPath, drawingWithLogo);
  await fs.writeFile(tempTemplatePath, await templateZip.generateAsync({ type: 'nodebuffer' }));

  const previousTemplatePath = process.env.REP_EXCEL_TEMPLATE_PATH;
  process.env.REP_EXCEL_TEMPLATE_PATH = tempTemplatePath;
  try {
    const report = makeReport();
    report.generalData.startDate = '2026-10-05';
    const generated = await generateRepExcelBuffer(report, {
      logoBuffer: await makeLogo(),
      logoMimeType: 'image/png',
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(generated.buffer);
    const main = workbook.getWorksheet('REPORTE REVISION PISO');

    assert.equal(main.getCell('AA1').value, 'Monterrey');
    assert.equal(main.getCell('AB1').value, 'Nuevo León');
    assert.equal(main.getCell('AC1').value, '41');
    assert.equal(main.getCell('AD1').value, '2026/10');
    assert.equal(main.getCell('AE1').value, '2026/41');
    assert.equal(main.getCell('AF1').value, 'MARCA');
    assert.equal(main.getCell('B5').value, 'Monterrey');
    assert.equal(main.getCell('C5').value, 'Nuevo León');
    assert.equal(main.getCell('U5').value, '41');
    assert.equal(main.getCell('X5').value, '2026/10');
    assert.equal(main.getCell('Y5').value, '2026/41');
    assert.equal(main.getCell('Z5').value, 'MARCA');
  } finally {
    if (previousTemplatePath === undefined) delete process.env.REP_EXCEL_TEMPLATE_PATH;
    else process.env.REP_EXCEL_TEMPLATE_PATH = previousTemplatePath;
  }
});

test('generates the workbook with general data, distinct actions, documentary values, and the brand logo', async () => {
  const original = await fs.readFile(templatePath);
  const generated = await generateRepExcelBuffer(makeReport(), {
    logoBuffer: await makeLogo(),
    logoMimeType: 'image/png',
  });

  test('uses the configured interval in the generated workbook filename', async () => {
    const report = makeReport();
    report.generalData.inspectionDate = '2026-09-01';
    const generated = await generateRepExcelBuffer(report, {
      logoBuffer: await makeLogo(),
      logoMimeType: 'image/png',
      intervalMonths: 2,
    });
    assert.equal(generated.downloadFileName, 'REP-INS-HYU-SEN-NL-(01-09-2026)-(01-11-2026).xlsx');
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(generated.buffer);
  const main = workbook.getWorksheet('REPORTE REVISION PISO');
  const documents = workbook.getWorksheet('REVISION DOCUMENTAL');

  assert.equal(generated.downloadFileName, 'REP-INS-HYU-SEN-NL-(29-10-2026)-(29-11-2026).xlsx');
  assert.equal(main.getCell('D3').value, 'Nombre Empresa (9.12 a): EMPRESA NORTE - SUCURSAL NORTE');
  assert.equal(main.getCell('D5').value, 'Calle Uno 123');
  assert.equal(main.getCell('E5').value, '29/10/2026');
  assert.equal(main.getCell('K5').value, 'Reponer etiqueta');
  assert.equal(main.getCell('M5').value, 'Inspección mensual');
  assert.equal(main.getCell('G5').value, 1);
  assert.equal(main.getCell('T5').value, 16000);
  assert.equal(main.getCell('K3').value.endsWith('Patio y almacén'), true);
  assert.equal(documents.getCell('E5').value, 'Cumple');
  assert.equal(documents.getCell('E6').value, 'Pendiente');
  assert.equal(main.getImages().length, 2);

  const zip = await JSZip.loadAsync(generated.buffer);
  const templateZip = await JSZip.loadAsync(original);
  for (const part of [
    'xl/styles.xml',
    'xl/drawings/drawing1.xml',
    'xl/drawings/_rels/drawing1.xml.rels',
    'xl/worksheets/_rels/sheet1.xml.rels',
  ]) {
    assert.equal(
      await zip.file(part).async('string'),
      await templateZip.file(part).async('string'),
      `${part} should retain the original template structure`,
    );
  }
  assert.match(await zip.file('xl/tables/table1.xml').async('string'), /tableStyleInfo/);
  const imagePaths = Object.keys(zip.files).filter((name) => /^xl\/media\//.test(name));
  assert.ok(imagePaths.length >= 2);
  assert.notDeepEqual(await fs.readFile(templatePath), generated.buffer);
  assert.ok(original.length > 0);
  assert.deepEqual(await fs.readFile(templatePath), original);
});

test('duplicates the styled finding row and removes it when there are no findings', async () => {
  const logoBuffer = await makeLogo();
  const multiple = await generateRepExcelBuffer(makeReport([{}, {}]), { logoBuffer, logoMimeType: 'image/png' });
  const multipleWorkbook = new ExcelJS.Workbook();
  await multipleWorkbook.xlsx.load(multiple.buffer);
  const multipleSheet = multipleWorkbook.getWorksheet('REPORTE REVISION PISO');
  assert.equal(multipleSheet.getCell('G5').value, 1);
  assert.equal(multipleSheet.getCell('G6').value, 2);
  assert.equal(multipleSheet.getCell('T7').value, 32000);
  const multipleZip = await JSZip.loadAsync(multiple.buffer);
  assert.match(await multipleZip.file('xl/tables/table1.xml').async('string'), /ref="A4:Z6"/);
  assert.equal(multipleZip.file('xl/calcChain.xml'), null);
  assert.doesNotMatch(await multipleZip.file('xl/_rels/workbook.xml.rels').async('string'), /\/calcChain/);

  const empty = await generateRepExcelBuffer(makeReport([]), { logoBuffer, logoMimeType: 'image/png' });
  const emptyWorkbook = new ExcelJS.Workbook();
  await emptyWorkbook.xlsx.load(empty.buffer);
  const emptySheet = emptyWorkbook.getWorksheet('REPORTE REVISION PISO');
  assert.equal(emptySheet.getCell('S6').value, 'MONTO ACUMULADO');
  assert.equal(emptySheet.getCell('T6').value, 0);
});
