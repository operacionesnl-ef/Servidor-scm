'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FILE_TYPES } = require('../src/utils/agencyFileRefreshUtils');
const { isVerifiedForPeriod } = require('../src/services/agencyRefreshJobWorker');

const verifiedAgency = (year, month) => ({
  archivos: Object.fromEntries(FILE_TYPES.map(({ key }) => [
    key,
    { driveId: `file-${key}`, periodYear: year, periodMonth: month },
  ])),
});

test('skips an agency only when all four files are verified for the requested month', () => {
  assert.equal(isVerifiedForPeriod(verifiedAgency(2026, 10), 2026, 10), true);
  assert.equal(isVerifiedForPeriod(verifiedAgency(2026, 9), 2026, 10), false);

  const incomplete = verifiedAgency(2026, 10);
  incomplete.archivos.archivo4.driveId = '';
  assert.equal(isVerifiedForPeriod(incomplete, 2026, 10), false);
});
