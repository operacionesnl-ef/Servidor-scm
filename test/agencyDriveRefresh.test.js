'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildAgencyRefresh, listDescendants } = require('../src/services/agencyDriveRefresh');

test('lists paginated Drive descendants on the server and retains folder paths', async () => {
  const requests = [];
  const drive = {
    files: {
      async list(options) {
        requests.push(options);
        if (options.q.includes("'root'")) {
          if (!options.pageToken) {
            return {
              data: {
                nextPageToken: 'next',
                files: [
                  { id: 'subfolder', name: '2026', mimeType: 'application/vnd.google-apps.folder' },
                ],
              },
            };
          }
          return { data: { files: [{ id: 'top-file', name: 'ignore.xlsx', parents: ['root'] }] } };
        }
        return {
          data: {
            files: [{ id: 'nested-file', name: 'REP-agosto.xlsx', parents: ['subfolder'] }],
          },
        };
      },
    },
  };

  const descendants = await listDescendants(drive, 'root');
  const nested = descendants.find(({ id }) => id === 'nested-file');

  assert.equal(descendants.length, 3);
  assert.deepEqual(nested.folderPath, ['2026']);
  assert.equal(nested.path, '2026/REP-agosto.xlsx');
  assert.equal(requests[0].supportsAllDrives, true);
  assert.equal(requests[0].includeItemsFromAllDrives, true);
  assert.equal(requests[1].pageToken, 'next');
});

test('builds persisted file records while preserving existing slots without a match', () => {
  const agency = {
    archivos: {
      archivo2: { nombre: 'FOR anterior.xlsx', ruta: 'previous-folder', driveId: 'previous-file' },
    },
  };
  const descendants = [
    {
      id: 'anx-file',
      name: 'ANX-evidencia.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      parents: ['month-folder'],
      folderPath: ['2026', 'Agosto'],
      path: '2026/Agosto/ANX-evidencia.xlsx',
    },
  ];

  const result = buildAgencyRefresh(agency, descendants, 2026, 8);

  assert.equal(result.results.archivo1.status, 'found');
  assert.equal(result.archivos.archivo1.driveId, 'anx-file');
  assert.equal(result.archivos.archivo2.driveId, 'previous-file');
  assert.equal(result.summary.found, 1);
  assert.equal(result.summary.missing, 3);
  assert.equal(result.scannedFiles, 1);
});
