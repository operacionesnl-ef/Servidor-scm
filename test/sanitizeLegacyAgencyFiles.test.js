'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Agency = require('../src/models/Agency');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const { sanitizeLegacyAgencyFiles } = require('../src/scripts/sanitizeLegacyAgencyFiles');

function makeQuery(agencies) {
  return {
    select() { return this; },
    lean() { return this; },
    cursor() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const agency of agencies) yield agency;
        },
      };
    },
  };
}

function makeMonthlyQuery(records) {
  return {
    select() { return this; },
    lean: async () => records,
  };
}

test('defaults to a read-only report and only counts Drive IDs backed by monthly records', async () => {
  const originalFind = Agency.find;
  const originalMonthlyFind = AgencyMonthlyFiles.find;
  const originalBulkWrite = Agency.collection.bulkWrite;
  let monthlyNullFilter;
  let filter;
  let monthlyFilter;
  Agency.find = (query) => {
    filter = query;
    return makeQuery([{
      _id: 'agency-1',
      updatedAt: new Date('2026-10-20T00:00:00.000Z'),
      archivos: {
        carpetaPrincipal: 'root-1',
        carpetaBase: 'base-1',
        archivo1: { nombre: 'ANX.pptx', driveId: 'file-1' },
        archivo2: { nombre: 'Legacy.xlsx', ruta: 'folder-2' },
        archivo3: null,
      },
    }]);
  };
  AgencyMonthlyFiles.find = (query) => {
    if (query.agencyId) {
      monthlyFilter = query;
      return makeMonthlyQuery([{
        archivos: { archivo4: { nombre: 'ANX.pptx', driveId: 'file-1' } },
      }]);
    }
    monthlyNullFilter = query;
    return makeQuery([{
      _id: 'monthly-record-1',
      archivos: { archivo4: null },
    }]);
  };
  Agency.collection.bulkWrite = async () => {
    throw new Error('Dry-run must not write to MongoDB.');
  };

  try {
    const stats = await sanitizeLegacyAgencyFiles();
    assert.deepEqual(filter, { archivos: { $exists: true } });
    assert.deepEqual(monthlyFilter, { agencyId: 'agency-1' });
    assert.equal(stats.agenciesWouldSanitize, 1);
    assert.equal(stats.duplicateFileSlots, 1);
    assert.equal(stats.nullFileSlots, 1);
    assert.equal(stats.legacySlotsWithoutDriveId, 1);
    assert.equal(stats.folderReferences, 2);
    assert.deepEqual(monthlyNullFilter, {
      $or: [
        { 'archivos.archivo1': { $type: 10 } },
        { 'archivos.archivo2': { $type: 10 } },
        { 'archivos.archivo3': { $type: 10 } },
        { 'archivos.archivo4': { $type: 10 } },
      ],
    });
    assert.equal(stats.monthlyRecordsWithNullSlots, 1);
    assert.equal(stats.monthlyNullFileSlots, 1);
    assert.equal(stats.applied, false);
  } finally {
    Agency.find = originalFind;
    AgencyMonthlyFiles.find = originalMonthlyFind;
    Agency.collection.bulkWrite = originalBulkWrite;
  }
});

test('only unsets verified duplicate slots when explicitly applied', async () => {
  const originalFind = Agency.find;
  const originalMonthlyFind = AgencyMonthlyFiles.find;
  const originalBulkWrite = Agency.collection.bulkWrite;
  const originalMonthlyBulkWrite = AgencyMonthlyFiles.collection.bulkWrite;
  let operations;
  let monthlyOperations;
  Agency.find = () => makeQuery([{
    _id: 'agency-2',
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    archivos: {
      carpetaPrincipal: 'root-2',
      archivo1: null,
      archivo3: { nombre: 'REP.xlsx', driveId: 'file-2' },
      archivo4: { nombre: 'Unverified.xlsx', driveId: 'file-not-migrated' },
    },
  }]);
  AgencyMonthlyFiles.find = (query) => (query.agencyId
    ? makeMonthlyQuery([{
      archivos: { archivo1: { nombre: 'REP.xlsx', driveId: 'file-2' } },
    }])
    : makeQuery([{
      _id: 'monthly-record-2',
      archivos: { archivo2: null, archivo4: null },
    }]));
  Agency.collection.bulkWrite = async (updates, options) => {
    operations = updates;
    assert.deepEqual(options, { ordered: false });
    return { matchedCount: 1, modifiedCount: 1 };
  };
  AgencyMonthlyFiles.collection.bulkWrite = async (updates, options) => {
    monthlyOperations = updates;
    assert.deepEqual(options, { ordered: false });
    return { matchedCount: 1, modifiedCount: 1 };
  };

  try {
    const stats = await sanitizeLegacyAgencyFiles({ apply: true });
    assert.equal(operations.length, 1);
    assert.equal(operations[0].updateOne.filter._id, 'agency-2');
    assert.equal(operations[0].updateOne.filter['archivos.archivo3.driveId'], 'file-2');
    assert.deepEqual(operations[0].updateOne.filter['archivos.archivo1'], { $type: 10 });
    assert.equal(operations[0].updateOne.filter['archivos.archivo4.driveId'], undefined);
    assert.deepEqual(operations[0].updateOne.update, {
      $unset: { 'archivos.archivo1': '', 'archivos.archivo3': '' },
    });
    assert.equal(stats.agenciesSanitized, 1);
    assert.equal(stats.duplicateFileSlots, 1);
    assert.equal(stats.nullFileSlots, 1);
    assert.equal(monthlyOperations.length, 1);
    assert.deepEqual(monthlyOperations[0].updateOne.update, {
      $unset: { 'archivos.archivo2': '', 'archivos.archivo4': '' },
    });
    assert.deepEqual(monthlyOperations[0].updateOne.filter['archivos.archivo2'], { $type: 10 });
    assert.equal(stats.monthlyRecordsSanitized, 1);
    assert.equal(stats.monthlyNullFileSlots, 2);
    assert.equal(stats.applied, true);
  } finally {
    Agency.find = originalFind;
    AgencyMonthlyFiles.find = originalMonthlyFind;
    Agency.collection.bulkWrite = originalBulkWrite;
    AgencyMonthlyFiles.collection.bulkWrite = originalMonthlyBulkWrite;
  }
});
