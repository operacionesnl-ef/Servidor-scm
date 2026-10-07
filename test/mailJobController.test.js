'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveAgencyAttachments } = require('../src/controllers/mailJobController');

test('does not require an optional agency attachment when it is absent', () => {
  const agency = { nombre: 'Agencia Norte', archivos: {} };
  const template = {
    archivosIndividuales: ['ANX'],
    archivosOpcionales: ['ANX'],
  };

  assert.deepEqual(resolveAgencyAttachments(agency, template), []);
});

test('includes available optional files and keeps required files attached', () => {
  const agency = {
    nombre: 'Agencia Norte',
    archivos: {
      archivo1: { driveId: 'drive-anx', nombre: 'anexo.pdf' },
      archivo2: { driveId: 'drive-for' },
    },
  };
  const template = {
    archivosIndividuales: ['ANX', 'FOR'],
    archivosOpcionales: ['ANX'],
  };

  assert.deepEqual(resolveAgencyAttachments(agency, template), [
    { code: 'ANX', driveId: 'drive-anx', nombre: 'anexo.pdf' },
    { code: 'FOR', driveId: 'drive-for', nombre: 'FOR.pdf' },
  ]);
});

test('continues to reject an absent required agency attachment', () => {
  const agency = { nombre: 'Agencia Norte', archivos: {} };
  const template = {
    archivosIndividuales: ['ANX'],
    archivosOpcionales: [],
  };

  assert.throws(
    () => resolveAgencyAttachments(agency, template),
    /Falta el archivo ANX para Agencia Norte/,
  );
});
