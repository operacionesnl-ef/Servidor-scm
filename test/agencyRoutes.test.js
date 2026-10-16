'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agencyRoutes = require('../src/routes/agencyRoutes');

test('registers maintenance history before the per-agency history route', () => {
  const paths = agencyRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);
  const maintenanceHistoryIndex = paths.indexOf('/maintenance/history');
  const agencyHistoryIndex = paths.indexOf('/:id/history');

  assert.notEqual(maintenanceHistoryIndex, -1);
  assert.notEqual(agencyHistoryIndex, -1);
  assert.ok(
    maintenanceHistoryIndex < agencyHistoryIndex,
    'the static maintenance route must not be handled as an agency ID',
  );
});
