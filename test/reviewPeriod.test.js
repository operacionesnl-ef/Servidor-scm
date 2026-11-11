'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReviewPeriod } = require('../src/utils/reviewPeriod');

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
