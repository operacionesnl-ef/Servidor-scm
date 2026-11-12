'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ensureRevFolder } = require('../src/formatosGeneradores/rev/services/revDriveStorage');

function makeDrive() {
  const files = [];
  let nextId = 0;
  return {
    files,
    client: {
      files: {
        list: async ({ q }) => {
          const parentId = q.match(/'([^']+)' in parents/)?.[1];
          const name = q.match(/name = '([^']+)'/)?.[1];
          return { data: { files: files.filter((file) => file.name === name && file.parents.includes(parentId)) } };
        },
        create: async ({ requestBody }) => {
          const folder = { id: `folder-${++nextId}`, name: requestBody.name, parents: requestBody.parents };
          files.push(folder);
          return { data: folder };
        },
      },
    },
  };
}

test('creates the REV folder under Recorrido de extintores using the Spanish month name', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const { client, files } = makeDrive();
  try {
    const folderId = await ensureRevFolder(client, {
      agencyBrandSnapshot: 'HYUNDAI',
      generalData: { inspectionDate: '2026-10-29' },
    });
    assert.deepEqual(files.map(({ name }) => name), [
      'Servicios EF', 'Recorrido de extintores', '2026', 'octubre', 'HYUNDAI',
    ]);
    assert.equal(folderId, files[4].id);
  } finally {
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});
