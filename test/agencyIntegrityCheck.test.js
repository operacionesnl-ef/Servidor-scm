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

test('does not treat absent ANX as an integrity issue for a regular agency', async () => {
  const agency = agencyWithFiles({
    archivo1: { nombre: '', ruta: '', driveId: '' },
  });
  const drive = {
    files: {
      async get({ fileId }) {
        const index = Number(fileId.slice(-1));
        const code = ['ANX', 'FOR', 'REP', 'REV'][index];
        return { data: { name: `${code}_2026_08.xlsx`, size: '10' } };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agency);

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.missingKeys, []);
  assert.deepEqual(result.optionalMissingKeys, ['archivo1']);
  assert.equal(result.checks[0].status, 'optional');
  assert.equal(result.checks[0].problems.length, 0);
});

test('treats absent REP, REV and ANX as optional for Chihuahua when FOR is linked', async () => {
  const agency = agencyWithFiles({
    archivo1: { nombre: '', ruta: '', driveId: '' },
    archivo3: { nombre: '', ruta: '', driveId: '' },
    archivo4: { nombre: '', ruta: '', driveId: '' },
  });
  agency.entidadFederativa = 'Chihuahua';
  const drive = {
    files: {
      async get() {
        return { data: { name: 'FOR_2026_08.xlsx', size: '10' } };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agency);

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.missingKeys, []);
  assert.deepEqual(result.optionalMissingKeys, ['archivo1', 'archivo3', 'archivo4']);
  assert.ok(result.checks.filter((check) => check.status === 'optional').length === 3);
});

test('requires FOR or both REP and REV for Chihuahua', async () => {
  const blankFile = { nombre: '', ruta: '', driveId: '' };
  const agency = agencyWithFiles({
    archivo1: blankFile,
    archivo2: blankFile,
    archivo3: blankFile,
    archivo4: blankFile,
  });
  agency.entidadFederativa = 'Chihuahua';
  const result = await inspectAgencyIntegrity({ files: { get: async () => ({ data: {} }) } }, agency);

  assert.equal(result.status, 'issues');
  assert.deepEqual(result.missingKeys, ['archivo2', 'archivo3', 'archivo4']);
  assert.deepEqual(result.optionalMissingKeys, ['archivo1']);
});

test('a Chihuahua agency with only REP still reports missing REV', async () => {
  const agency = agencyWithFiles({
    archivo1: { nombre: '', ruta: '', driveId: '' },
    archivo2: { nombre: '', ruta: '', driveId: '' },
    archivo4: { nombre: '', ruta: '', driveId: '' },
  });
  agency.entidadFederativa = 'Chihuahua';
  const drive = {
    files: {
      async get({ fileId }) {
        if (fileId === 'file-2') {
          return { data: { name: 'REP_2026_08.xlsx', size: '10' } };
        }
        return { data: {} };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agency);

  assert.equal(result.status, 'issues');
  assert.deepEqual(result.missingKeys, ['archivo4']);
  assert.deepEqual(result.optionalMissingKeys, ['archivo1', 'archivo2']);
  assert.equal(result.checks[0].status, 'optional');
  assert.equal(result.checks[1].status, 'optional');
  assert.equal(result.checks[3].status, 'error');
});

test('reports a stale filename date range even when its stored folder period is current', async () => {
  const agency = agencyWithFiles({
    archivo1: {
      nombre: 'H.REV-FOT-JAC-CUU-CUU-11-05-2026 - 11-06-2026.pptx',
      pseudoPath: ['2026', 'Octubre'],
      periodMonth: 10,
    },
  });
  const drive = {
    files: {
      async get({ fileId }) {
        if (fileId === 'file-0') {
          return {
            data: {
              name: 'H.REV-FOT-JAC-CUU-CUU-11-05-2026 - 11-06-2026.pptx',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              size: '10',
            },
          };
        }
        return { data: { name: 'REV_2026_08.xlsx', size: '10' } };
      },
    },
  };

  const result = await inspectAgencyIntegrity(drive, agency, { year: 2026, month: 10 });

  assert.equal(result.checks[0].status, 'warning');
  assert.ok(result.checks[0].problems.includes(
    'El rango de fechas del nombre corresponde a un período anterior.'
  ));
});
