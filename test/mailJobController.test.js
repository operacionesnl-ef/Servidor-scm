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
      archivo1: {
        driveId: 'drive-anx',
        nombre: 'ANX-anexo-2026-10.pptx',
        periodYear: 2026,
        periodMonth: 10,
      },
      archivo2: { driveId: 'drive-for' },
    },
  };
  const template = {
    archivosIndividuales: ['ANX', 'FOR'],
    archivosOpcionales: ['ANX'],
  };

  assert.deepEqual(resolveAgencyAttachments(agency, template, 2026, 10), [
    { code: 'ANX', driveId: 'drive-anx', nombre: 'ANX-anexo-2026-10.pptx', optional: true },
    { code: 'FOR', driveId: 'drive-for', nombre: 'FOR.pdf' },
  ]);
});

test('omits an optional file whose saved period does not match the email period', () => {
  const agency = {
    nombre: 'Agencia Toyota Victoria',
    archivos: {
      archivo1: {
        driveId: 'drive-anx',
        nombre: 'ANX-FOT-TOY-(27-07-26)-(27-08-26).pptx',
        periodYear: 2026,
        periodMonth: 7,
      },
      archivo2: {
        driveId: 'drive-for',
        nombre: 'FOR-AUD-AMB-TOY-(14-09-26)-(14-10-26).xlsx',
        periodYear: 2026,
        periodMonth: 9,
      },
    },
  };
  const template = {
    archivosIndividuales: ['ANX', 'FOR'],
    archivosOpcionales: ['ANX'],
  };

  assert.deepEqual(resolveAgencyAttachments(agency, template, 2026, 9), [
    { code: 'FOR', driveId: 'drive-for', nombre: 'FOR-AUD-AMB-TOY-(14-09-26)-(14-10-26).xlsx' },
  ]);
});

test('omits an optional file when its period cannot be validated', () => {
  const agency = {
    nombre: 'Agencia Norte',
    archivos: {
      archivo1: { driveId: 'drive-anx', nombre: 'ANX-anexo.pdf' },
    },
  };
  const template = {
    archivosIndividuales: ['ANX'],
    archivosOpcionales: ['ANX'],
  };

  assert.deepEqual(resolveAgencyAttachments(agency, template, 2026, 10), []);
});

test('does not omit a required file just because its period differs', () => {
  const agency = {
    nombre: 'Agencia Norte',
    archivos: {
      archivo1: {
        driveId: 'drive-anx',
        nombre: 'ANX-anexo-2026-07.pdf',
        periodYear: 2026,
        periodMonth: 7,
      },
    },
  };
  const template = {
    archivosIndividuales: ['ANX'],
    archivosOpcionales: [],
  };

  assert.deepEqual(resolveAgencyAttachments(agency, template, 2026, 10), [
    { code: 'ANX', driveId: 'drive-anx', nombre: 'ANX-anexo-2026-07.pdf' },
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
