'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const BRAND_LOGO_PATHS = require('../src/config/repBrandLogoPaths');

function makeFolderDrive() {
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

test('creates the REP workbook folder using the FOR year/month/brand hierarchy', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const { client, files } = makeFolderDrive();
  try {
    const folderId = await ensureRepFolder(client, {
      agencyBrandSnapshot: 'HYUNDAI',
      generalData: { inspectionDate: '2026-10-29' },
    });
    assert.deepEqual(files.map(({ name }) => name), [
      'Servicios EF', 'Recorridos Medio Ambiente', '2026', '10', 'HYUNDAI',
    ]);
    assert.equal(folderId, files[4].id);
  } finally {
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});

test('stores REP photos under Evidencias/year/month/agency/REP/reportId', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const { client, files } = makeFolderDrive();
  const report = {
    reportId: 'REP-123',
    agencyNameSnapshot: 'Sucursal Norte',
    generalData: { inspectionDate: '2026-10-29' },
    save: async () => {},
  };
  try {
    const folderId = await ensureRepImageFolder(client, report);
    assert.deepEqual(files.map(({ name }) => name), [
      'Evidencias', '2026', '10', 'Sucursal-Norte', 'REP', 'REP-123',
    ]);
    assert.equal(report.drive.evidenceFolderId, folderId);
  } finally {
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});
const {
  ensureRepFolder,
  ensureRepImageFolder,
  getBrandLogo,
  normalizeBrand,
  resolveBrandLogo,
  uploadRepAnxToDrive,
} = require('../src/formatosGeneradores/rep/services/repDriveStorage');

test('uploads the generated ANX PowerPoint to the report folder with revision identity', async () => {
  let uploaded;
  const drive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async (request) => {
        uploaded = request;
        return { data: { id: 'anx-drive-id', name: request.requestBody.name } };
      },
    },
  };
  const stored = await uploadRepAnxToDrive(drive, {
    folderId: 'rep-folder',
    reportId: 'REP-123',
    revision: 3,
    fileName: 'ANX-FOT-TEST.pptx',
    buffer: Buffer.from('presentation'),
  });

  assert.equal(stored.driveFileId, 'anx-drive-id');
  assert.equal(uploaded.requestBody.parents[0], 'rep-folder');
  assert.equal(uploaded.media.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.deepEqual(uploaded.requestBody.appProperties, {
    efcoreGeneratedAnx: 'REP-FOT',
    efcoreGeneratedReportId: 'REP-123',
    efcoreGeneratedRevision: '3',
  });
});

test('normalizes brand names for case-, accent-, and separator-insensitive logo lookup', () => {
  assert.equal(normalizeBrand('  Hýundai Motor '), 'hyundaimotor');
});

test('resolves a unique matching image under Recursos/Logotipos', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const queries = [];
  const drive = {
    files: {
      list: async ({ q, pageToken }) => {
        queries.push(q);
        if (q.includes("name = 'Recursos'")) return { data: { files: [{ id: 'resources', name: 'Recursos' }] } };
        if (q.includes("name = 'Logotipos'")) return { data: { files: [{ id: 'logos', name: 'Logotipos' }] } };
        if (pageToken) return { data: { files: [{ id: 'another', name: 'Otra marca.jpg', mimeType: 'image/jpeg' }] } };
        return { data: { files: [
          { id: 'unrelated', name: 'OtraMarca.png', mimeType: 'image/png' },
          { id: 'brand-logo', name: 'Hýundai Motor.PNG', mimeType: 'image/png' },
        ], nextPageToken: 'next-page' } };
      },
    },
  };
  try {
    const logo = await resolveBrandLogo(drive, 'HYUNDAI MOTOR');
    assert.equal(logo.id, 'brand-logo');
    assert.equal(queries.length, 4);
  } finally {
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});

test('allows several normalized brands to share one configured Drive image URL', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const drive = {
    files: {
      get: async ({ fileId }) => ({
        data: { id: fileId, name: 'shared.png', mimeType: 'image/png', trashed: false },
      }),
      list: async () => {
        throw new Error('Configured Drive links should not require a folder search.');
      },
    },
  };
  const sharedLogoUrl = 'https://drive.google.com/open?id=shared-logo';
  const logoPaths = {
    BRANDONE: sharedLogoUrl,
    BRANDTWO: sharedLogoUrl,
  };
  try {
    const first = await resolveBrandLogo(drive, 'Brand One', logoPaths);
    const second = await resolveBrandLogo(drive, 'Brand Two', logoPaths);
    assert.equal(first.id, 'shared-logo');
    assert.equal(second.id, first.id);
  } finally {
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});

test('resolves a case-insensitive brand from the configured Google Drive URL map', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const [configuredBrand, configuredUrl] = Object.entries(BRAND_LOGO_PATHS)[0] || [];
  assert.ok(configuredBrand && configuredUrl, 'At least one logo mapping must be configured.');
  const configuredFileId = new URL(configuredUrl).searchParams.get('id')
    || new URL(configuredUrl).pathname.match(/\/file\/d\/([^/]+)/)?.[1];
  const drive = {
    files: {
      get: async ({ fileId }) => ({
        data: { id: fileId, name: 'BMW.png', mimeType: 'image/png', trashed: false },
      }),
    },
  };
  try {
    const logo = await resolveBrandLogo(drive, configuredBrand.toLowerCase());
    assert.equal(logo.id, configuredFileId);
  } finally {
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});

test('downloads a publicly shared logo when the current Drive OAuth scope cannot read its file ID', async () => {
  const previousRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  const previousFetch = global.fetch;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root';
  const [configuredBrand, configuredUrl] = Object.entries(BRAND_LOGO_PATHS)[0] || [];
  assert.ok(configuredBrand && configuredUrl, 'At least one logo mapping must be configured.');
  const configuredFileId = new URL(configuredUrl).searchParams.get('id')
    || new URL(configuredUrl).pathname.match(/\/file\/d\/([^/]+)/)?.[1];
  const drive = {
    files: {
      get: async () => {
        const error = new Error('Insufficient permissions');
        error.response = { status: 403 };
        throw error;
      },
    },
  };
  global.fetch = async (url) => {
    assert.equal(new URL(url).searchParams.get('id'), configuredFileId);
    let read = false;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true };
            read = true;
            return { done: false, value: Buffer.from('public-image-data') };
          },
          cancel: async () => {},
        }),
      },
    };
  };
  try {
    const logo = await getBrandLogo(drive, configuredBrand);
    assert.equal(logo.mimeType, 'image/png');
    assert.equal(logo.buffer.toString(), 'public-image-data');
  } finally {
    global.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = previousRoot;
  }
});
