'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectAgencyIntegrity } = require('../src/services/agencyIntegrityCheck');

function agencyWithFiles(overrides = {}) {
  const codes = ['ANX', 'FOR', 'REP', 'REV'];
  const files = Object.fromEntries(codes.map((code, index) => [`archivo${index + 1}`, {
    nombre: `${code}_2026_08.xlsx`,
    ruta: `folder-${index}`,
    driveId: `file-${index}`,
    pseudoPath: ['2026', 'Agosto'],
    periodYear: 2026,
    periodMonth: 8,
    ...overrides[`archivo${index + 1}`],
  }]));
  return { nombre: 'Agencia de prueba', archivos: files };
}

test('checks file marks, date, size and modified date using Drive metadata', async () => {
  const drive = {
    files: {
      async get({ fileId }) {
        const index = Number(fileId.slice(-1));
        const code = ['ANX', 'FOR', 'REP', 'REV'][index];
        return {
          data: {
            id: fileId,
            name: `${code}_2026_08.xlsx`,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: '2048',
            modifiedTime: '2026-08-12T10:00:00.000Z',
          },
        };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agencyWithFiles());

  assert.equal(result.status, 'updated');
  assert.equal(result.checks.length, 4);
  assert.equal(result.checks[0].status, 'ok');
  assert.equal(result.checks[0].sizeBytes, 2048);
  assert.deepEqual(result.checks[0].period, { year: 2026, month: 8 });
  assert.equal(result.checks[0].modifiedTime, '2026-08-12T10:00:00.000Z');
  assert.equal(result.checks[0].fileName, 'ANX_2026_08.xlsx');
  assert.equal(result.checks[0].path, '2026/Agosto/ANX_2026_08.xlsx');
});

test('does not report a changed Drive filename as an integrity problem', async () => {
  const drive = {
    files: {
      async get({ fileId }) {
        const index = Number(fileId.slice(-1));
        const code = ['ANX', 'FOR', 'REP', 'REV'][index];
        return {
          data: {
            id: fileId,
            name: ` ${code}_2026_08.xlsx`,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: '2048',
            modifiedTime: '2026-08-12T10:00:00.000Z',
          },
        };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agencyWithFiles());

  assert.equal(result.status, 'updated');
  assert.ok(result.checks.every((check) => check.status === 'ok'));
  assert.ok(result.checks.every((check) => check.problems.length === 0));
});

test('reports files that do not match the selected search period', async () => {
  const drive = {
    files: {
      async get({ fileId }) {
        const index = Number(fileId.slice(-1));
        const code = ['ANX', 'FOR', 'REP', 'REV'][index];
        return { data: { name: `${code}_2026_08.xlsx`, size: '10' } };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agencyWithFiles(), { year: 2026, month: 9 });

  assert.equal(result.status, 'issues');
  assert.ok(result.checks.every((check) => (
    check.problems.includes('La fecha del archivo no coincide con el período seleccionado.')
  )));
});

test('reports a missing mark, date mismatch, and missing Drive files as integrity issues', async () => {
  const agency = agencyWithFiles({
    archivo1: { nombre: 'ANX_2026_08.xlsx' },
    archivo2: { nombre: 'FOR_2026_07.xlsx', periodMonth: 8 },
    archivo3: { driveId: '' },
  });
  const drive = {
    files: {
      async get({ fileId }) {
        if (fileId === 'month-folder') {
          return {
            data: {
              name: 'Julio',
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['year-folder'],
            },
          };
        }
        if (fileId === 'year-folder') {
          return {
            data: {
              name: '2026',
              mimeType: 'application/vnd.google-apps.folder',
              parents: [],
            },
          };
        }
        if (fileId === 'file-0') {
          return { data: { name: 'otro_2026_08.xlsx', size: '10' } };
        }
        return { data: { name: 'FOR_2026_08.xlsx', size: '10', parents: ['month-folder'] } };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agency);

  assert.equal(result.status, 'issues');
  assert.deepEqual(result.missingKeys, ['archivo3']);
  assert.ok(result.checks[0].problems.some((problem) => problem.includes('marca ANX')));
  assert.ok(result.checks[1].problems.some((problem) => problem.includes('período guardado')));
  assert.equal(result.checks[2].status, 'error');
});
