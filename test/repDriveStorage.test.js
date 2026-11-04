'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeBrand, resolveBrandLogo } = require('../src/formatosGeneradores/rep/services/repDriveStorage');

test('normalizes brand names for case-, accent-, and separator-insensitive logo lookup', () => {
  assert.equal(normalizeBrand('  Hýundai Motor '), 'hyundaimotor');
});

test('resolves a unique matching image under Recursos/Logotipos', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const queries = [];
  const drive = {
    files: {
      list: async ({ q }) => {
        queries.push(q);
        if (q.includes("name = 'Recursos'")) return { data: { files: [{ id: 'resources', name: 'Recursos' }] } };
        if (q.includes("name = 'Logotipos'")) return { data: { files: [{ id: 'logos', name: 'Logotipos' }] } };
        return { data: { files: [
          { id: 'unrelated', name: 'OtraMarca.png', mimeType: 'image/png' },
          { id: 'brand-logo', name: 'Hýundai Motor.PNG', mimeType: 'image/png' },
        ] } };
      },
    },
  };
  try {
    const logo = await resolveBrandLogo(drive, 'HYUNDAI MOTOR');
    assert.equal(logo.id, 'brand-logo');
    assert.equal(queries.length, 3);
  } finally {
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});
