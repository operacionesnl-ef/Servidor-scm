'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const {
  getAgencyMonthlyFiles,
  saveAgencyMonthlyFiles,
  validateMonthlyFiles,
} = require('../src/controllers/agencyMonthlyFilesController');
const agencyRoutes = require('../src/routes/agencyRoutes');
const { migrate } = require('../src/scripts/migrateAgencyMonthlyFiles');

const sampleFile = {
  nombre: 'Reporte.xlsx',
  ruta: 'folder-1',
  driveId: 'file-1',
  pseudoPath: ['2026', 'Octubre'],
  path: '2026/Octubre/Reporte.xlsx',
  sizeBytes: 1200,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  modifiedTime: '2026-10-20T15:00:00.000Z',
};

test('validates monthly file metadata and stamps its selected period', () => {
  const { errors, value } = validateMonthlyFiles({
    carpetaPrincipal: 'root-1',
    archivos: {
      archivo1: null,
      archivo2: null,
      archivo3: sampleFile,
      archivo4: null,
    },
  }, '2026-10');

  assert.deepEqual(errors, {});
  assert.equal(value.archivos.archivo3.periodYear, 2026);
  assert.equal(value.archivos.archivo3.periodMonth, 10);
  assert.equal(value.archivos.archivo3.sizeBytes, 1200);
  assert.equal(value.archivos.archivo1, undefined);
});

test('rejects invalid periods, unknown file metadata, and negative sizes', () => {
  const { errors } = validateMonthlyFiles({
    archivos: {
      archivo3: { ...sampleFile, sizeBytes: -1, unexpected: true },
    },
  }, '2041-13');

  assert.ok(errors.period);
  assert.ok(errors['archivos.archivo3.sizeBytes']);
  assert.ok(errors['archivos.archivo3.unexpected']);
});

test('enforces one monthly file record per agency and period', () => {
  const indexes = AgencyMonthlyFiles.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => (
    fields.agencyId === 1 && fields.period === 1 && options.unique
  )));
  assert.equal(AgencyMonthlyFiles.schema.path('carpetaPrincipal'), undefined);
  assert.equal(AgencyMonthlyFiles.schema.path('carpetaBase'), undefined);
  assert.equal(Agency.schema.path('archivos.archivo1'), undefined);
  assert.equal(Agency.schema.path('archivos.carpetaPrincipal').instance, 'String');
});

test('reads a missing monthly record without creating a database row', async () => {
  const originalFindById = Agency.findById;
  const originalFindOne = AgencyMonthlyFiles.findOne;
  Agency.findById = () => ({
    select() { return this; },
    lean: async () => ({ archivos: { carpetaPrincipal: 'root-1' } }),
  });
  AgencyMonthlyFiles.findOne = () => ({ lean: async () => null });
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await getAgencyMonthlyFiles({
      params: { id: new mongoose.Types.ObjectId().toString(), period: '2026-10' },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.record, null);
  } finally {
    Agency.findById = originalFindById;
    AgencyMonthlyFiles.findOne = originalFindOne;
  }
});

test('upserts monthly files and writes folder configuration only to Agency', async () => {
  const originalFindById = Agency.findById;
  const originalAgencyUpdateOne = Agency.updateOne;
  const originalMonthlyFindOne = AgencyMonthlyFiles.findOne;
  const originalFindOneAndUpdate = AgencyMonthlyFiles.findOneAndUpdate;
  const originalMonthlyUpdateMany = AgencyMonthlyFiles.collection.updateMany;
  const agencyId = new mongoose.Types.ObjectId();
  const file = {
    nombre: 'Reporte.xlsx',
    ruta: 'folder-1',
    driveId: 'file-1',
    pseudoPath: ['2026', 'Octubre'],
    path: '2026/Octubre/Reporte.xlsx',
    sizeBytes: 1200,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    modifiedTime: '2026-10-20T15:00:00.000Z',
    periodYear: 2026,
    periodMonth: 10,
  };
  let agencyUpdate;
  let updateFilter;
  const agency = {
    _id: agencyId,
    archivos: { carpetaPrincipal: '', carpetaBase: '' },
  };
  Agency.findById = async () => agency;
  Agency.updateOne = async (...args) => { agencyUpdate = args; };
  AgencyMonthlyFiles.findOne = () => ({ lean: async () => ({ archivos: { archivo3: file } }) });
  AgencyMonthlyFiles.findOneAndUpdate = async (filter) => {
    updateFilter = filter;
    return {
      agencyId,
      period: '2026-10',
      archivos: { archivo3: file },
      toObject() { return this; },
    };
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await saveAgencyMonthlyFiles({
      params: { id: agencyId.toString(), period: '2026-10' },
      user: { _id: new mongoose.Types.ObjectId() },
      body: {
        carpetaPrincipal: 'root-1',
        archivos: {
          archivo1: null,
          archivo2: null,
          archivo3: sampleFile,
          archivo4: null,
        },
      },
    }, res, (error) => { throw error; });
    assert.deepEqual(updateFilter, { agencyId, period: '2026-10' });
    assert.deepEqual(agencyUpdate[1], { $set: { 'archivos.carpetaPrincipal': 'root-1' } });
    assert.deepEqual(agency.archivos, { carpetaPrincipal: 'root-1', carpetaBase: '' });
    assert.equal(res.body.data.archivos.archivo3.periodYear, 2026);
    assert.equal(res.statusCode, 200);
  } finally {
    Agency.findById = originalFindById;
    Agency.updateOne = originalAgencyUpdateOne;
    AgencyMonthlyFiles.findOne = originalMonthlyFindOne;
    AgencyMonthlyFiles.findOneAndUpdate = originalFindOneAndUpdate;
    AgencyMonthlyFiles.collection.updateMany = originalMonthlyUpdateMany;
  }
});

test('registers period-specific monthly file read and protected write routes', () => {
  const methodsByPath = new Map();
  agencyRoutes.stack.filter((layer) => layer.route).forEach((layer) => {
    methodsByPath.set(layer.route.path, {
      ...methodsByPath.get(layer.route.path),
      ...layer.route.methods,
    });
  });
  assert.equal(methodsByPath.get('/:id/monthly-files/:period').get, true);
  assert.equal(methodsByPath.get('/:id/monthly-files/:period').put, true);
  const writeRoute = agencyRoutes.stack.find((layer) => (
    layer.route?.path === '/:id/monthly-files/:period' && layer.route.methods.put
  ));
  assert.equal(writeRoute.route.stack.length, 2);
});

test('migration is dry-run by default and infers periods from file metadata', async () => {
  const originalFind = Agency.find;
  const originalUpdateOne = AgencyMonthlyFiles.updateOne;
  const originalFindOne = AgencyMonthlyFiles.findOne;
  const originalAgencyCollectionUpdateOne = Agency.collection.updateOne;
  const originalMonthlyCollectionUpdateMany = AgencyMonthlyFiles.collection.updateMany;
  const originalCreateIndexes = AgencyMonthlyFiles.createIndexes;
  const agencyId = new mongoose.Types.ObjectId();
  const calls = [];
  const legacyAgency = {
    _id: agencyId,
    archivos: {
      carpetaPrincipal: 'root-1',
      archivo1: { ...sampleFile, periodYear: 2026, periodMonth: 10 },
      archivo2: { nombre: 'Unknown.pdf', driveId: 'unknown' },
      archivo3: { ...sampleFile },
    },
  };
  const query = {
    select() { return this; },
    lean() { return this; },
    cursor() {
      return {
        async *[Symbol.asyncIterator]() { yield legacyAgency; },
      };
    },
  };
  Agency.find = () => query;
  AgencyMonthlyFiles.findOne = () => ({
    select() { return this; },
    lean: async () => null,
  });
  AgencyMonthlyFiles.createIndexes = async () => [];
  AgencyMonthlyFiles.updateOne = async (...args) => {
    calls.push(args);
    return { upsertedCount: 1 };
  };
  Agency.collection.updateOne = async () => ({ modifiedCount: 1 });
  AgencyMonthlyFiles.collection.updateMany = async () => ({ modifiedCount: 0 });

  try {
    const dryRun = await migrate();
    assert.equal(dryRun.periodsFound, 1);
    assert.equal(dryRun.unresolvedFiles.length, 1);
    assert.equal(dryRun.recordsCreated, 0);
    assert.equal(calls.length, 0);

    const applied = await migrate({ apply: true });
    assert.equal(applied.recordsCreated, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].period, '2026-10');
    assert.ok(calls[0][1].$setOnInsert);
    assert.equal(calls[0][2].upsert, true);
  } finally {
    Agency.find = originalFind;
    AgencyMonthlyFiles.updateOne = originalUpdateOne;
    AgencyMonthlyFiles.findOne = originalFindOne;
    Agency.collection.updateOne = originalAgencyCollectionUpdateOne;
    AgencyMonthlyFiles.collection.updateMany = originalMonthlyCollectionUpdateMany;
    AgencyMonthlyFiles.createIndexes = originalCreateIndexes;
  }
});
