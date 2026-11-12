'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const {
  ensureGeneratedExcelFolder,
  ForReportDriveStorageError,
  uploadGeneratedExcelToDrive,
} = require('../src/formatosGeneradores/for/services/forReportDriveStorage');

const originalRootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

afterEach(() => {
  if (originalRootFolderId === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = originalRootFolderId;
});

function makeDrive() {
  let nextId = 0;
  const files = [];
  const requests = [];
  return {
    files,
    requests,
    drive: {
      files: {
        async list({ q }) {
          requests.push({ operation: 'list', q });
          const parent = q.match(/'([^']+)' in parents/)?.[1];
          const name = q.match(/name = '([^']+)'/)?.[1];
          if (parent && name) {
            return { data: { files: files.filter((file) => file.name === name && file.parents.includes(parent)) } };
          }
          const properties = [...q.matchAll(/key='([^']+)' and value='([^']*)'/g)]
            .map((match) => [match[1], match[2]]);
          return {
            data: {
              files: files.filter((file) => properties.every(([key, value]) => file.appProperties?.[key] === value)),
            },
          };
        },
        async create({ requestBody, media }) {
          const file = {
            id: `drive-${++nextId}`,
            name: requestBody.name,
            mimeType: requestBody.mimeType || media.mimeType,
            parents: requestBody.parents || [],
            appProperties: requestBody.appProperties || {},
          };
          files.push(file);
          requests.push({ operation: 'create', requestBody, media });
          return { data: file };
        },
        async update(request) {
          requests.push({ operation: 'update', request });
          const file = files.find(({ id }) => id === request.fileId);
          file.name = request.requestBody.name;
          file.appProperties = request.requestBody.appProperties;
          if (request.addParents) {
            file.parents = file.parents
              .filter((parent) => !request.removeParents?.split(',').includes(parent))
              .concat(request.addParents);
          }
          return { data: file };
        },
      },
    },
  };
}

test('creates the configured Drive hierarchy through brand and monthly period', async () => {
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root-folder';
  const { drive, files } = makeDrive();
  const folderId = await ensureGeneratedExcelFolder(drive, {
    agencyBrandSnapshot: 'HYUNDAI',
    agencyPeriod: '2026-10',
    generalData: { inspectionDate: '2026-10-01' },
  });

  assert.equal(files.length, 5);
  assert.deepEqual(files.map(({ name }) => name), [
    'Servicios EF',
    'Recorridos Medio Ambiente',
    '2026',
    'octubre',
    'HYUNDAI',
  ]);
  assert.equal(folderId, files[4].id);
  assert.equal(files[4].parents[0], files[3].id);
});

test('requires a configured agency brand before creating the destination folder', async () => {
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root-folder';
  const { drive } = makeDrive();

  await assert.rejects(
    ensureGeneratedExcelFolder(drive, {
      agencyBrandSnapshot: '',
      agencyPeriod: '2026-10',
      generalData: { inspectionDate: '2026-10-01' },
    }),
    (error) => error instanceof ForReportDriveStorageError && /marca de la agencia/i.test(error.message),
  );
});

test('uploads to Drive and replaces the same report file on later revisions', async () => {
  const { drive, files, requests } = makeDrive();
  const buffer = Buffer.from('workbook-bytes');
  const first = await uploadGeneratedExcelToDrive(drive, {
    folderId: 'brand-folder-1',
    reportId: 'FOR-12345678-1234-1234-1234-123456789012',
    revision: 3,
    fileName: 'FOR-AUD-AMB-HYU-SEN-NL.xlsx',
    buffer,
  });
  const second = await uploadGeneratedExcelToDrive(drive, {
    folderId: 'brand-folder-2',
    reportId: 'FOR-12345678-1234-1234-1234-123456789012',
    revision: 4,
    fileName: 'FOR-AUD-AMB-HYU-SEN-NL.xlsx',
    buffer,
  });

  assert.equal(first.driveFileId, second.driveFileId);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].parents, ['brand-folder-2']);
  assert.equal(files[0].appProperties.efcoreGeneratedRevision, '4');
  assert.equal(requests.filter(({ operation }) => operation === 'create').length, 1);
  assert.equal(requests.filter(({ operation }) => operation === 'update').length, 1);
});
