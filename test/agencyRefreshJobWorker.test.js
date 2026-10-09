'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FILE_TYPES } = require('../src/utils/agencyFileRefreshUtils');
const { isVerifiedForPeriod } = require('../src/services/agencyRefreshJobWorker');

const verifiedAgency = (year, month) => ({
  entidadFederativa: 'Nuevo León',
  archivos: Object.fromEntries(FILE_TYPES.map(({ key }) => [
    key,
    {
      nombre: `${key}.xlsx`,
      ruta: `folder-${key}`,
      driveId: `file-${key}`,
      periodYear: year,
      periodMonth: month,
    },
  ])),
});

test('skips an agency when all required files are verified for the requested month', () => {
  assert.equal(isVerifiedForPeriod(verifiedAgency(2026, 10), 2026, 10), true);
  assert.equal(isVerifiedForPeriod(verifiedAgency(2026, 9), 2026, 10), false);

  const incomplete = verifiedAgency(2026, 10);
  incomplete.archivos.archivo4.driveId = '';
  assert.equal(isVerifiedForPeriod(incomplete, 2026, 10), false);

  const noAnx = verifiedAgency(2026, 10);
  noAnx.archivos.archivo1 = null;
  assert.equal(isVerifiedForPeriod(noAnx, 2026, 10), true);

  assert.equal(isVerifiedForPeriod({
    entidadFederativa: 'Chihuahua',
    archivos: {
      archivo1: null,
      archivo2: verifiedAgency(2026, 10).archivos.archivo2,
      archivo3: null,
      archivo4: null,
    },
  }, 2026, 10), true);
});
