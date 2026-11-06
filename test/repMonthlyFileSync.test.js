'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const ANX = require('../src/formatosGeneradores/rep/models/ANX');
const { syncRepReportMonthlyFile } = require('../src/formatosGeneradores/rep/services/repMonthlyFileSync');

const originalFindOne = ANX.findOne;
const originalFindOneAndUpdate = AgencyMonthlyFiles.findOneAndUpdate;

afterEach(() => {
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
