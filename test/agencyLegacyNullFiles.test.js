'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { removeNullAgencyFileSlots } = require('../src/controllers/agencyController');

test('omits empty legacy file slots while retaining folder IDs and populated files', () => {
  assert.deepEqual(removeNullAgencyFileSlots({
    carpetaPrincipal: 'agency-root',
    carpetaBase: 'base-folder',
    archivo1: null,
    archivo2: { nombre: 'FOR.xlsx', ruta: 'folder-2', driveId: 'file-2' },
    archivo3: null,
  }), {
    carpetaPrincipal: 'agency-root',
    carpetaBase: 'base-folder',
    archivo2: { nombre: 'FOR.xlsx', ruta: 'folder-2', driveId: 'file-2' },
  });
});
