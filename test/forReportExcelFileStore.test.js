'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { getOutputDirectory } = require('../src/formatosGeneradores/for/services/forReportExcelFileStore');

test('exposes the absolute directory for legacy local Excel files', () => {
  assert.equal(typeof getOutputDirectory, 'function');
  assert.equal(path.isAbsolute(getOutputDirectory()), true);
});
