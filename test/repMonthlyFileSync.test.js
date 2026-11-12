'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const ANX = require('../src/formatosGeneradores/rep/models/ANX');
const { syncRepReportMonthlyFile } = require('../src/formatosGeneradores/rep/services/repMonthlyFileSync');

const originalMonthlyFindOne = AgencyMonthlyFiles.findOne;
const originalFindOne = ANX.findOne;
const originalFindOneAndUpdate = AgencyMonthlyFiles.findOneAndUpdate;

afterEach(() => {
  AgencyMonthlyFiles.findOne = originalMonthlyFindOne;
  ANX.findOne = originalFindOne;
  AgencyMonthlyFiles.findOneAndUpdate = originalFindOneAndUpdate;
});

test('links a ready generated ANX to its monthly system slot', async () => {
  const updates = [];
  ANX.findOne = () => ({
    lean: async () => ({
      totalImagenes: 1,
      archivoGenerado: {
        estado: 'ready',
        revision: 3,
        driveFileId: 'anx-drive-id',
        nombre: 'ANX-FOT-TEST.pptx',
      },
    }),
  });
  AgencyMonthlyFiles.findOne = () => ({
    select() { return this; },
    lean: async () => null,
  });
  AgencyMonthlyFiles.findOneAndUpdate = async (...args) => {
    updates.push(args);
    return {};
  };
  await syncRepReportMonthlyFile({
    reportId: 'REP-123',
    agencyId: 'agency-1',
    revision: 3,
    generalData: { inspectionDate: '2026-10-29' },
    generatedExcel: { status: 'not_requested' },
    updatedBy: 'user-1',
  });

  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1][0], { agencyId: 'agency-1', period: '2026-10' });
  assert.equal(updates[1][1].$set['archivos.archivo1'].mode, 'system');
  assert.equal(updates[1][1].$set['archivos.archivo1'].generatedAnxStatus, 'ready');
  assert.equal(updates[1][1].$set['archivos.archivo1'].driveId, 'anx-drive-id');
  assert.equal(updates[1][1].$set['archivos.archivo1'].systemReportId, 'REP-123');
});

test('preserves a Drive REP while syncing its generated system report', async () => {
  const updates = [];
  ANX.findOne = () => ({ lean: async () => null });
  AgencyMonthlyFiles.findOne = () => ({
    select() { return this; },
    lean: async () => ({
      archivos: {
        archivo3: {
          mode: 'drive',
          nombre: 'REP-INS-manual.xlsx',
          ruta: 'manual-folder',
          driveId: 'manual-rep-drive',
        },
      },
    }),
  });
  AgencyMonthlyFiles.findOneAndUpdate = async (...args) => { updates.push(args); return {}; };

  await syncRepReportMonthlyFile({
    reportId: 'REP-123',
    agencyId: 'agency-1',
    revision: 3,
    generalData: { inspectionDate: '2026-10-29' },
    generatedExcel: { status: 'queued', reportRevision: 3, downloadFileName: 'REP-INS-generado.xlsx' },
    updatedBy: 'user-1',
  });

  assert.equal(updates[0][1].$set['archivos.archivo3.mode'], undefined);
  assert.equal(updates[0][1].$set['archivos.archivo3.driveId'], undefined);
  assert.equal(updates[0][1].$set['archivos.archivo3.systemReportId'], 'REP-123');
  assert.equal(updates[0][1].$set['archivos.archivo3.systemNombre'], 'REP-INS-generado.xlsx');
});

test('syncs ANX status without overwriting the REP Excel status', async () => {
  const updates = [];
  ANX.findOne = () => ({
    lean: async () => ({
      totalImagenes: 1,
      archivoGenerado: {
        estado: 'ready',
        revision: 3,
        driveFileId: 'anx-drive-id',
        nombre: 'ANX-FOT-TEST.pptx',
      },
    }),
  });
  AgencyMonthlyFiles.findOne = () => {
    throw new Error('ANX-only sync must not read the REP slot');
  };
  AgencyMonthlyFiles.findOneAndUpdate = async (...args) => { updates.push(args); return {}; };

  await syncRepReportMonthlyFile({
    reportId: 'REP-123',
    agencyId: 'agency-1',
    revision: 3,
    generalData: { inspectionDate: '2026-10-29' },
    generatedExcel: { status: 'ready', reportRevision: 3 },
    updatedBy: 'user-1',
  }, { syncExcel: false });

  assert.equal(updates.length, 1);
  assert.equal(updates[0][1].$set['archivos.archivo1'].generatedAnxStatus, 'ready');
});
