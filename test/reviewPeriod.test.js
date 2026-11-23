'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getReviewIntervalMonths,
  isReviewDue,
  resolveReviewPeriod,
} = require('../src/utils/reviewPeriod');

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

test('determines scheduled review months from the start month and interval', () => {
  const reviewPeriods = new Map([
    ['ambiental', { startPeriod: '2026-10', intervalMonths: 3 }],
    ['seguridad', { startPeriod: '2026-11', intervalMonths: 2 }],
  ]);

  assert.equal(isReviewDue(reviewPeriods, 'ambiental', 2026, 10), true);
  assert.equal(isReviewDue(reviewPeriods, 'ambiental', 2026, 11), false);
  assert.equal(isReviewDue(reviewPeriods, 'ambiental', 2027, 1), true);
  assert.equal(isReviewDue(reviewPeriods, 'seguridad', 2026, 10), false);
  assert.equal(isReviewDue(reviewPeriods, 'seguridad', 2027, 1), true);
});

test('uses monthly cadence when no valid start period is configured', () => {
  assert.equal(isReviewDue({}, 'ambiental', 2026, 10), true);
  assert.equal(isReviewDue({
    ambiental: { intervalMonths: 3 },
  }, 'ambiental', 2026, 10), true);
});
