'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getReviewIntervalMonths, resolveReviewPeriod } = require('../src/utils/reviewPeriod');

test('review periods use the latest scheduled month from category start', () => {
  const settings = { startPeriod: '2026-01', intervalMonths: 2 };
  assert.equal(resolveReviewPeriod('2026-01', settings), '2026-01');
  assert.equal(resolveReviewPeriod('2026-02', settings), '2026-01');
  assert.equal(resolveReviewPeriod('2026-03', settings), '2026-03');
  assert.equal(resolveReviewPeriod('2027-01', settings), '2027-01');
});

test('review period leaves dates before the configured start unchanged', () => {
  assert.equal(resolveReviewPeriod('2025-12', { startPeriod: '2026-01', intervalMonths: 2 }), '2025-12');
  assert.equal(resolveReviewPeriod('2026-06', undefined), '2026-06');
});

test('reads the configured review interval from object and map settings', () => {
  assert.equal(getReviewIntervalMonths({ seguridad: { intervalMonths: 2 } }, 'seguridad'), 2);
  assert.equal(getReviewIntervalMonths(new Map([['seguridad', { intervalMonths: 3 }]]), 'seguridad'), 3);
  assert.equal(getReviewIntervalMonths({}, 'seguridad'), 1);
});
