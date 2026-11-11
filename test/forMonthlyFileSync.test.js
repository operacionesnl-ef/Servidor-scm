'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const { syncForReportMonthlyFile } = require('../src/formatosGeneradores/for/services/forMonthlyFileSync');

const originalFindOne = AgencyMonthlyFiles.findOne;
const originalFindOneAndUpdate = AgencyMonthlyFiles.findOneAndUpdate;

afterEach(() => {
  AgencyMonthlyFiles.findOne = originalFindOne;
  AgencyMonthlyFiles.findOneAndUpdate = originalFindOneAndUpdate;
});

test('preserves a Drive FOR while syncing its generated system report', async () => {
  let update;
  AgencyMonthlyFiles.findOne = () => ({
    select() { return this; },
    lean: async () => ({
      archivos: {
        archivo2: {
          mode: 'drive',
          nombre: 'FOR-AUD-AMB-manual.xlsx',
          ruta: 'manual-folder',
          driveId: 'manual-for-drive',
        },
      },
    }),
  });
  AgencyMonthlyFiles.findOneAndUpdate = async (_filter, value) => { update = value; return {}; };

  try {
    await syncForReportMonthlyFile({
      reportId: 'FOR-12345678-1234-1234-1234-123456789012',
      agencyId: 'agency-1',
      revision: 3,
      agencyPeriod: '2026-10',
      generalData: { inspectionDate: '2026-10-29' },
      generatedExcel: {
        status: 'queued',
        reportRevision: 3,
        downloadFileName: 'FOR-AUD-AMB-generado.xlsx',
      },
      updatedBy: 'user-1',
    });

    assert.equal(update.$set['archivos.archivo2.mode'], undefined);
    assert.equal(update.$set['archivos.archivo2.driveId'], undefined);
    assert.equal(update.$set['archivos.archivo2.systemReportId'], 'FOR-12345678-1234-1234-1234-123456789012');
    assert.equal(update.$set['archivos.archivo2.systemNombre'], 'FOR-AUD-AMB-generado.xlsx');
    assert.equal(update.$set['archivos.archivo2.generatedExcelStatus'], 'queued');
  } finally {
    AgencyMonthlyFiles.findOne = originalFindOne;
    AgencyMonthlyFiles.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
