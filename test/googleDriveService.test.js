'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  deleteDriveFile,
  findOrCreateRootFolder,
  getDriveFileMetadata,
  getRootFolderStatus,
  uploadDriveFile,
} = require('../src/services/googleDriveService');

test('reuses a folder created for the application instead of creating a duplicate', async () => {
  let createCalls = 0;
  const drive = {
    files: {
      list: async () => ({ data: { files: [{ id: 'folder-1', name: 'EFCORE_STORAGE_APP' }] } }),
      create: async () => {
        createCalls += 1;
        return { data: { id: 'unexpected', name: 'EFCORE_STORAGE_APP' } };
      },
    },
  };

  const folder = await findOrCreateRootFolder(drive, 'EFCORE_STORAGE_APP');

  assert.deepEqual(folder, { id: 'folder-1', name: 'EFCORE_STORAGE_APP' });
  assert.equal(createCalls, 0);
});

test('creates the application root folder when it does not exist', async () => {
  let createRequest;
  const drive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async (request) => {
        createRequest = request;
        return { data: { id: 'folder-2', name: 'EFCORE_STORAGE_APP' } };
      },
    },
  };

  const folder = await findOrCreateRootFolder(drive, 'EFCORE_STORAGE_APP');

  assert.deepEqual(folder, { id: 'folder-2', name: 'EFCORE_STORAGE_APP' });
  assert.equal(createRequest.requestBody.mimeType, 'application/vnd.google-apps.folder');
});

test('reports setup as incomplete without a refresh token or root folder id', async (context) => {
  const originalRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const originalRootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  context.after(() => {
    if (originalRefreshToken === undefined) delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    else process.env.GOOGLE_OAUTH_REFRESH_TOKEN = originalRefreshToken;
    if (originalRootFolderId === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = originalRootFolderId;
  });

  assert.deepEqual(await getRootFolderStatus(), {
    configured: false,
    message: 'Configura el refresh token y el ID de la carpeta raíz en el entorno del backend.',
  });
});

test('uploads a file under the selected parent folder', async () => {
  let uploadRequest;
  const expected = { id: 'file-1', name: 'evidence.jpg', parents: ['folder-1'] };
  const drive = {
    files: {
      create: async (request) => {
        uploadRequest = request;
        return { data: expected };
      },
    },
  };

  const result = await uploadDriveFile(drive, {
    folderId: 'folder-1',
    fileName: 'evidence.jpg',
    mimeType: 'image/jpeg',
    body: Buffer.from('test-image'),
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(uploadRequest.requestBody.parents, ['folder-1']);
  assert.equal(uploadRequest.media.mimeType, 'image/jpeg');
});

test('reads file metadata and deletes by Drive ID', async () => {
  const calls = [];
  const drive = {
    files: {
      get: async (request) => {
        calls.push(['get', request]);
        return { data: { id: request.fileId, name: 'evidence.jpg', trashed: false } };
      },
      delete: async (request) => calls.push(['delete', request]),
    },
  };

  const metadata = await getDriveFileMetadata(drive, 'file-1');
  await deleteDriveFile(drive, metadata.id);

  assert.deepEqual(metadata, { id: 'file-1', name: 'evidence.jpg', trashed: false });
  assert.deepEqual(calls.map(([operation]) => operation), ['get', 'delete']);
  assert.deepEqual(calls[1][1], { fileId: 'file-1' });
});

test('rejects upload and deletion requests without required Drive identifiers', async () => {
  const drive = { files: { create: async () => assert.fail('unexpected upload') } };
  await assert.rejects(uploadDriveFile(drive, { fileName: 'missing-parent' }), TypeError);
  await assert.rejects(deleteDriveFile(drive, ''), TypeError);
});
