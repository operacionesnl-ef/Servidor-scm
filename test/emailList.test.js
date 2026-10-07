'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mergeEmailLists, normalizeEmailList } = require('../src/utils/emailList');

test('normalizes and deduplicates recipient addresses', () => {
  const errors = {};
  const result = normalizeEmailList([' CC@example.com ', 'cc@example.com', 'other@example.com'], 'cc', errors);

  assert.deepEqual(result, ['cc@example.com', 'other@example.com']);
  assert.deepEqual(errors, {});
});

test('rejects invalid and oversized recipient lists', () => {
  const errors = {};
  normalizeEmailList(['not-an-email'], 'cc', errors);
  normalizeEmailList(Array(21).fill('person@example.com'), 'cco', errors);

  assert.equal(errors['cc.0'], 'Must be a valid email address');
  assert.match(errors.cco, /at most 20/);
});

test('combines template and agency recipient lists without duplicate addresses', () => {
  const errors = {};
  const result = mergeEmailLists(
    [['shared@example.com', 'template@example.com'], ['SHARED@example.com', 'agency@example.com']],
    'cc',
    errors,
  );

  assert.deepEqual(result, ['shared@example.com', 'template@example.com', 'agency@example.com']);
  assert.deepEqual(errors, {});
});

test('allows the combined template and agency list limits', () => {
  const errors = {};
  const result = mergeEmailLists([
    Array.from({ length: 20 }, (_, index) => `template-${index}@example.com`),
    Array.from({ length: 20 }, (_, index) => `agency-${index}@example.com`),
  ], 'cc', errors);

  assert.equal(result.length, 40);
  assert.deepEqual(errors, {});
});
