'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const { getAgencies, refreshAgencyFiles } = require('../src/controllers/agencyController');
const { FILE_TYPES, selectRefreshFiles } = require('../src/utils/agencyFileRefreshUtils');

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

test('refresh persists files and GET agencies reads their per-file periods from MongoDB', {
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

    const { statusCode, body } = await invokeController(refreshAgencyFiles, {
      params: { id: agency.id },
      body: {
        year: 2025,
        month: 8,
        descendants: [
          driveFile('ANX', 2025, 6),
          driveFile('REP', 2025, 8),
          driveFile('REV', 2025, 7),
          driveFile('XYZ', 2025, 8),
        ],
      },
    });

    assert.equal(statusCode, 200);
    assert.equal(body.data.summary.found, 3);
    assert.equal(body.data.summary.missing, 1);
    assert.equal(body.data.summary.year, 2025);
    assert.equal(body.data.summary.month, 8);
    assert.equal(body.data.results.archivo1.periodMonth, 6);
    assert.equal(body.data.results.archivo2.status, 'missing');
    assert.equal(body.data.results.archivo3.periodMonth, 8);
    assert.equal(body.data.results.archivo4.periodMonth, 7);

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