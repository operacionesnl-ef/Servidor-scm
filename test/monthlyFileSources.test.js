'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hasIndependentDriveFile } = require('../src/utils/monthlyFileSources');

test('recognizes legacy Drive files and distinguishes the system-generated Drive output', () => {
  assert.equal(hasIndependentDriveFile({ driveId: 'legacy-drive-file' }), true);
  assert.equal(hasIndependentDriveFile({ mode: 'drive', driveId: 'manual-drive-file' }), true);
  assert.equal(hasIndependentDriveFile({
    mode: 'system',
    systemReportId: 'REV-report',
    driveId: 'generated-drive-file',
    systemDriveId: 'generated-drive-file',
  }), false);
  assert.equal(hasIndependentDriveFile({
    systemReportId: 'REV-report',
    driveId: 'generated-drive-file',
    systemDriveId: 'generated-drive-file',
  }), false);
  assert.equal(hasIndependentDriveFile({
    mode: 'system',
    systemReportId: 'REV-report',
    driveId: 'manual-drive-file',
    systemDriveId: 'generated-drive-file',
  }), true);
});
