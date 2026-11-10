'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const { DEFAULT_TEMPLATE_PATH, generateRevExcelBuffer } = require('../src/formatosGeneradores/rev/services/revExcelGenerator');

async function getDrawingImage(zip, drawingNumber, pictureName) {
  const drawingPath = `xl/drawings/drawing${drawingNumber}.xml`;
  const drawing = await zip.file(drawingPath).async('string');
  const picture = [...drawing.matchAll(/<xdr:pic>[\s\S]*?<\/xdr:pic>/g)]
    .find(([xml]) => xml.includes(`name="${pictureName}"`));
  assert.ok(picture, `existe ${pictureName} en drawing${drawingNumber}`);
  const relationId = picture[0].match(/\br:embed="([^"]+)"/)?.[1];
  assert.ok(relationId);
  const rels = await zip.file(`xl/drawings/_rels/drawing${drawingNumber}.xml.rels`).async('string');
  const relationship = rels.match(/<Relationship\b[^>]*\/>/g)
    .find((entry) => entry.includes(`Id="${relationId}"`));
  assert.ok(relationship);
  const target = relationship.match(/\bTarget="\.\.\/media\/([^"]+)"/)?.[1];
  assert.ok(target);
  const image = zip.file(`xl/media/${target}`);
  assert.ok(image);
  return image.async('nodebuffer');
}

test('genera REV con datos automáticos, copia fila de inspección y conserva la carátula', async () => {
  const inspectionRow = (n) => ({
    n,
    pqs: 'X',
    co2: '',
    agua: '',
    tipod: '',
    tipok: '',
    capacidad: '10 kg',
    pintura: 'BUENO',
    golpes: 'NO',
    adhesivo: 'SI',
    transporte: 'BUENO',
    disparo: 'BUENO',
    presion: 'BUENO',
    manometro: 'BUENO',
    manguera: 'BUENO',
    ring: 'BUENO',
    boquilla: 'BUENO',
    senalizacion: 'SI',
    libre: 'SI',
    limpio: 'SI',
    fecha_carga: '2026-01-02',
    fecha_vencimiento: '2027-01-02',
    status: 'VIGENTE',
    observaciones: '',
    ubicacion: n === 1 ? 'Show room' : 'Taller',
  });
  const report = {
    generalData: { inspectionDate: '2026-11-05', responsible: 'Responsable' },
    agencyNameSnapshot: 'Sucursal Centro',
    agencyLegalNameSnapshot: 'Empresa de Prueba',
    agencyAddressSnapshot: 'Av. Central 123',
    agencyBrandSnapshot: 'CLEBER',
    agencyFileNameCodeSnapshot: 'SUC-01',
    extinguishers: [inspectionRow(1), inspectionRow(2)],
  };
  const logoBuffer = await sharp({
    create: { width: 10, height: 10, channels: 4, background: '#123456' },
  }).png().toBuffer();

  const generated = await generateRevExcelBuffer(report, { logoBuffer, logoMimeType: 'image/png' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(generated.buffer);
  const inspection = workbook.worksheets.find(({ name }) => name === 'INSPECCIÓN');
  assert.equal(inspection.getCell('G3').value, '05/11/2026');
  assert.equal(inspection.getCell('X3').value, 'NOVIEMBRE');
  assert.equal(inspection.getCell('G4').value, 'Responsable');
  assert.equal(inspection.getCell('A11').value, 1);
  assert.equal(inspection.getCell('Y11').value, 'Show room');
  assert.equal(inspection.getCell('A12').value, 2);
  assert.equal(inspection.getCell('Y12').value, 'Taller');

  const zip = await JSZip.loadAsync(generated.buffer);
  const drawing = await zip.file('xl/drawings/drawing1.xml').async('string');
  assert.match(drawing, /Empresa de Prueba/);
  assert.match(drawing, /Sucursal Centro/);
  assert.match(drawing, /NOVIEMBRE/);
  assert.match(drawing, /2026/);
  assert.match(drawing, /name="cleber"/);
  assert.doesNotMatch(drawing, /\{(?:mes|year|razon_social|sucursal)\}/);
  assert.equal(generated.downloadFileName, 'REV-EXT-SUC-01-(05-11-26)-(05-12-26).xlsx');
  const templateZip = await JSZip.loadAsync(await fs.readFile(DEFAULT_TEMPLATE_PATH));
  const expectedLogo = await sharp(logoBuffer).png().toBuffer();
  for (const drawingNumber of [1, 2]) {
    const sheetRels = await zip.file(`xl/worksheets/_rels/sheet${drawingNumber}.xml.rels`).async('string');
    assert.match(sheetRels, new RegExp(`Target="\\.\\./drawings/drawing${drawingNumber}\\.xml"`));
    assert.deepEqual(await getDrawingImage(zip, drawingNumber, 'logotipo'), expectedLogo);
  }
  assert.deepEqual(await getDrawingImage(zip, 1, 'cleber'), await getDrawingImage(templateZip, 1, 'cleber'));
  assert.deepEqual(await getDrawingImage(zip, 2, 'image2.png'), await getDrawingImage(templateZip, 2, 'image2.png'));

  const nonCleber = await generateRevExcelBuffer({
    ...report,
    agencyBrandSnapshot: 'OTRA MARCA',
  }, { logoBuffer, logoMimeType: 'image/png' });
  const nonCleberZip = await JSZip.loadAsync(nonCleber.buffer);
  const nonCleberDrawing = await nonCleberZip.file('xl/drawings/drawing1.xml').async('string');
  assert.doesNotMatch(nonCleberDrawing, /name="cleber"/);
  for (const drawingNumber of [1, 2]) {
    assert.deepEqual(await getDrawingImage(nonCleberZip, drawingNumber, 'logotipo'), expectedLogo);
  }
  assert.deepEqual(await getDrawingImage(nonCleberZip, 2, 'image2.png'), await getDrawingImage(templateZip, 2, 'image2.png'));
});

test('convierte el logotipo JPEG para ambas hojas REV', async () => {
  const report = {
    generalData: { inspectionDate: '2026-11-05', responsible: 'Responsable' },
    agencyNameSnapshot: 'Sucursal Centro',
    agencyBrandSnapshot: 'OTRA MARCA',
    extinguishers: [],
  };
  const logoBuffer = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#123456' },
  }).jpeg().toBuffer();
  const generated = await generateRevExcelBuffer(report, { logoBuffer, logoMimeType: 'image/jpeg' });
  const zip = await JSZip.loadAsync(generated.buffer);
  const expectedLogo = await sharp(logoBuffer).png().toBuffer();
  for (const drawingNumber of [1, 2]) {
    assert.deepEqual(await getDrawingImage(zip, drawingNumber, 'logotipo'), expectedLogo);
  }
});

test('colorea solo la fuente de las 13 respuestas REV según su valor', async () => {
  const checkFields = [
    'pintura', 'golpes', 'adhesivo', 'transporte', 'disparo', 'presion', 'manometro',
    'manguera', 'ring', 'boquilla', 'senalizacion', 'libre', 'limpio',
  ];
  const checkValues = ['1', '0', 'NA', '2', 'NR', 'NT', 'OTRO', '', '1', '0', 'NA', '2', 'NR'];
  const report = {
    generalData: { inspectionDate: '2026-11-05', responsible: 'Responsable' },
    agencyNameSnapshot: 'Sucursal Centro',
    agencyLegalNameSnapshot: 'Empresa de Prueba',
    agencyBrandSnapshot: 'CLEBER',
    agencyFileNameCodeSnapshot: 'SUC-01',
    extinguishers: [{
      n: 1,
      pqs: 'X',
      co2: '',
      agua: '',
      tipod: '',
      tipok: '',
      capacidad: 4.5,
      ...Object.fromEntries(checkFields.map((field, index) => [field, checkValues[index]])),
      fecha_carga: '',
      fecha_vencimiento: '',
      status: 'En buen estado',
      observaciones: '',
      ubicacion: 'Almacén',
    }],
  };
  const logoBuffer = await sharp({
    create: { width: 10, height: 10, channels: 4, background: '#123456' },
  }).png().toBuffer();
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.readFile(DEFAULT_TEMPLATE_PATH);
  const templateInspection = templateWorkbook.getWorksheet('INSPECCIÓN');

  const generated = await generateRevExcelBuffer(report, { logoBuffer, logoMimeType: 'image/png' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(generated.buffer);
  const inspection = workbook.getWorksheet('INSPECCIÓN');
  const expectedColors = [
    'FF00B050', 'FF000000', 'FFA12727', 'FFA12727', 'FFA12727', 'FFA12727',
    'FFA12727', 'FF00B050', 'FF00B050', 'FF000000', 'FFA12727', 'FFA12727', 'FFA12727',
  ];
  const withoutColor = ({ color, ...font }) => font;

  assert.equal(generated.templateVersion, '1.2');
  checkFields.forEach((field, index) => {
    const cell = inspection.getCell(11, 8 + index);
    const templateCell = templateInspection.getCell(11, 8 + index);
    assert.equal(cell.value, checkValues[index], `${field} conserva su valor`);
    assert.deepEqual(cell.font.color, { argb: expectedColors[index] }, `${field} usa el color esperado`);
    assert.deepEqual(withoutColor(cell.font), withoutColor(templateCell.font), `${field} conserva el resto de la fuente`);
    assert.deepEqual(cell.fill, templateCell.fill, `${field} conserva su relleno`);
  });
});
