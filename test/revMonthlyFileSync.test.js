'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const { syncRevReportMonthlyFile } = require('../src/formatosGeneradores/rev/services/revMonthlyFileSync');

test('REV sync keeps an existing Drive file and updates the system sidecar', async () => {
  const originalFindOne = AgencyMonthlyFiles.findOne;
  const originalFindOneAndUpdate = AgencyMonthlyFiles.findOneAndUpdate;
  let update;
  AgencyMonthlyFiles.findOne = () => ({
    select() { return this; },
    async lean() {
      return {
        archivos: {
          archivo4: {
            mode: 'drive',
            nombre: 'REV-EXT-manual.xlsx',
            ruta: 'manual-folder',
            driveId: 'manual-drive-file',
          },
        },
      };
    },
  });
  AgencyMonthlyFiles.findOneAndUpdate = async (_filter, value) => { update = value; };

  try {
    await syncRevReportMonthlyFile({
      agencyId: 'agency-1',
      reportId: 'REV-12345678-1234-1234-1234-123456789012',
      revision: 3,
      createdBy: 'user-1',
      generalData: { inspectionDate: '2026-10-01' },
      generatedExcel: {
        status: 'queued',
        reportRevision: 3,
        downloadFileName: 'REV-EXT-generated.xlsx',
      },
    });

    const set = update.$set;
    assert.equal(set['archivos.archivo4.mode'], undefined);
    assert.equal(set['archivos.archivo4.driveId'], undefined);
    assert.equal(set['archivos.archivo4.systemReportId'], 'REV-12345678-1234-1234-1234-123456789012');
    assert.equal(set['archivos.archivo4.systemNombre'], 'REV-EXT-generated.xlsx');
    assert.equal(set['archivos.archivo4.generatedExcelStatus'], 'queued');
  } finally {
    AgencyMonthlyFiles.findOne = originalFindOne;
    AgencyMonthlyFiles.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
