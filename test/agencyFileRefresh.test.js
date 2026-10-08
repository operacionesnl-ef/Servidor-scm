'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const { getAgencies } = require('../src/controllers/agencyController');
const { FILE_TYPES, getFilePeriod, selectRefreshFiles } = require('../src/utils/agencyFileRefreshUtils');
const { buildAgencyRefresh } = require('../src/services/agencyDriveRefresh');

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function driveFile(code, year, month, overrides = {}) {
  const name = `${code}-documento.xlsx`;
  const folderPath = [String(year), MONTH_NAMES[month - 1]];
  return {
    id: `${code}-${year}-${month}`,
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parents: [`folder-${year}-${month}`],
    folderPath,
    path: `${folderPath.join('/')}/${name}`,
    modifiedTime: `${year}-${String(month).padStart(2, '0')}-15T12:00:00.000Z`,
    size: '1024',
    ...overrides,
  };
}

function invokeController(handler, req) {
  let statusCode = 200;
  let body;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return value;
    },
  };

  return Promise.resolve(handler(req, res, (error) => {
    if (error) throw error;
  })).then(() => ({ statusCode, body }));
}

test('selects the newest recognized period at or before the requested month', () => {
  const selected = selectRefreshFiles([
    driveFile('ANX', 2025, 6),
    driveFile('ANX', 2025, 7),
    driveFile('ANX', 2025, 9),
  ], 2025, 8);

  assert.equal(selected.archivo1.period.year, 2025);
  assert.equal(selected.archivo1.period.month, 7);
});

test('uses October folder metadata instead of a September date in the filename', () => {
  const octoberFile = driveFile('ANX', 2026, 10, {
    name: 'ANX-documento-30-09-2026.xlsx',
  });

  const selected = selectRefreshFiles([octoberFile], 2026, 10);

  assert.equal(selected.archivo1.period.year, 2026);
  assert.equal(selected.archivo1.period.month, 10);
});

test('does not infer a period from a dated filename when its folders have no period', () => {
  const file = driveFile('ANX', 2026, 9, {
    name: 'ANX-documento-30-09-2026.xlsx',
    folderPath: ['Agencia', 'Sucursal 09'],
    path: 'Agencia/Sucursal 09/ANX-documento-30-09-2026.xlsx',
  });

  assert.equal(selectRefreshFiles([file], 2026, 10).archivo1, null);
});

test('uses the date belonging to a month-only folder across supported date formats', () => {
  const names = [
    'ANX-FOT-KIA-PZA-VER-(20/09/2026).xlsx',
    'ANX-FOT-KIA-PZA-VER-(20/09/26).xlsx',
    'ANX-FOT-KIA-PZA-VER-(09/20/2026).xlsx',
    'ANX-FOT-KIA-PZA-VER-(20/09/2026)-(20/10/2026).xlsx',
    'ANX-FOT-KIA-PZA-VER-(20/09/26)-(20/10/26).xlsx',
    'ANX-FOT-KIA-PZA-VER-(09/22/26)-(10/22/2026).xlsx',
  ];

  for (const name of names) {
    const file = {
      ...driveFile('ANX', 2026, 9),
      name,
      folderPath: ['VERACRUZ', 'POZA RICA', 'KIA TAJIN', 'Septiembre'],
      path: `VERACRUZ/POZA RICA/KIA TAJIN/Septiembre/${name}`,
    };
    assert.deepEqual(getFilePeriod(file), { year: 2026, month: 9 }, name);
    assert.equal(selectRefreshFiles([file], 2026, 10).archivo1.period.month, 9, name);
  }
});

test('uses the ending date when a file range starts in the previous month', () => {
  const files = [
    ['ANX', 'Copia de ANX-FOT-BYD-CAN-NL-(14-08-26)-(14-09-26).pptx'],
    ['FOR', 'FOR-AUD-AMB-BYD-CAN-NL-(24-09-26)-(24-10-26).xlsx'],
    ['REP', 'Copia de REP-INS-BYD-CAN-NL-(14-08-26)-(14-09-26).xlsx'],
    ['REV', 'REV-EXT-BYD-CAN-NL-(14-08-26)-(14-09-26).xlsx'],
  ].map(([code, name]) => ({
    ...driveFile(code, 2026, 9),
    name,
    folderPath: ['Agencia', 'Septiembre'],
    path: `Agencia/Septiembre/${name}`,
  }));

  const selected = selectRefreshFiles(files, 2026, 9);

  for (const { key, code } of FILE_TYPES) {
    assert.ok(selected[key], `expected a file for ${key}`);
    assert.equal(selected[key].file.name, files.find((file) => file.name.startsWith(code) || file.name.startsWith(`Copia de ${code}`)).name);
    assert.deepEqual(selected[key].period, { year: 2026, month: 9 });
  }
});

test('does not choose a newer folder containing only irrelevant files', () => {
  const irrelevant = driveFile('XYZ', 2025, 8);
  const selected = selectRefreshFiles([
    driveFile('REP', 2025, 7),
    irrelevant,
  ], 2025, 8);

  assert.equal(selected.archivo3.period.month, 7);
  assert.equal(selected.archivo1, null);
});

test('recognizes all agency codes when separated by spaces, hyphens, dots, or underscores', () => {
  const files = [
    driveFile('ANX', 2025, 8, { name: 'ANX reporte.xlsx' }),
    driveFile('FOR', 2025, 8, { name: 'FOR-reporte.xlsx' }),
    driveFile('REP', 2025, 8, { name: 'REP.reporte.xlsx' }),
    driveFile('REV', 2025, 8, { name: 'REV_reporte.xlsx' }),
  ];
  const selected = selectRefreshFiles(files, 2025, 8);

  for (const { key } of FILE_TYPES) assert.equal(selected[key].period.month, 8);
});

test('recognizes a document type from folder names when the filename has no code', () => {
  const file = driveFile('XYZ', 2025, 8, {
    name: 'archivo.xlsx',
    folderPath: ['Agencia', '2025', 'Agosto', 'Formulario Auditoria Ambiental'],
  });
  const selected = selectRefreshFiles([file], 2025, 8);

  assert.equal(selected.archivo2.file.id, file.id);
});

test('reports empty slots and keeps the actual period independently for each file', () => {
  const selected = selectRefreshFiles([
    driveFile('ANX', 2025, 6),
    driveFile('REP', 2025, 8),
    driveFile('REV', 2025, 7),
  ], 2025, 8);

  assert.equal(selected.archivo1.period.month, 6);
  assert.equal(selected.archivo2, null);
  assert.equal(selected.archivo3.period.month, 8);
  assert.equal(selected.archivo4.period.month, 7);
});

test('refresh results persist files and GET agencies reads their per-file periods from MongoDB', {
  skip: !process.env.TEST_MONGO_URI,
}, async () => {
  await mongoose.connect(process.env.TEST_MONGO_URI);
  const correo = `agency-refresh-${randomUUID()}@example.test`;
  let agency;

  try {
    agency = await Agency.create({
      nombre: 'Agencia de prueba refresh',
      correo,
      entidadFederativa: 'Chihuahua',
      archivos: {
        archivo2: { nombre: 'FOR existente.xlsx', ruta: 'existing-folder', driveId: 'existing-file' },
      },
    });

    const update = buildAgencyRefresh(agency, [
      driveFile('ANX', 2025, 6),
      driveFile('REP', 2025, 8),
      driveFile('REV', 2025, 7),
      driveFile('XYZ', 2025, 8),
    ], 2025, 8);
    agency.set('archivos', update.archivos);
    await agency.save();

    assert.equal(update.summary.found, 3);
    assert.equal(update.summary.missing, 1);
    assert.equal(update.summary.year, 2025);
    assert.equal(update.summary.month, 8);
    assert.equal(update.results.archivo1.periodMonth, 6);
    assert.equal(update.results.archivo2.status, 'missing');
    assert.equal(update.results.archivo3.periodMonth, 8);
    assert.equal(update.results.archivo4.periodMonth, 7);

    const stored = await Agency.findById(agency.id).lean();
    assert.equal(stored.archivos.archivo1.driveId, 'ANX-2025-6');
    assert.equal(stored.archivos.archivo1.path, '2025/Junio/ANX-documento.xlsx');
    assert.equal(stored.archivos.archivo1.periodYear, 2025);
    assert.equal(stored.archivos.archivo1.periodMonth, 6);
    assert.equal(stored.archivos.archivo1.pseudoPath.join('/'), '2025/Junio');
    assert.equal(stored.archivos.archivo2.driveId, 'existing-file');

    const getResponse = await invokeController(getAgencies, { query: {} });
    const fetched = getResponse.body.data.find((item) => String(item._id) === agency.id);
    assert.ok(fetched);
    assert.equal(fetched.archivos.archivo3.periodMonth, 8);
    assert.equal(fetched.archivos.archivo4.periodMonth, 7);
  } finally {
    if (agency) await Agency.deleteOne({ _id: agency._id });
    await mongoose.disconnect();
  }
});