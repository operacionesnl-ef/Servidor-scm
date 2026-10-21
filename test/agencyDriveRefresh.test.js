'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const {
  buildAgencyRefresh,
  listDescendants,
  refreshAgencyFromDrive,
} = require('../src/services/agencyDriveRefresh');

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

test('builds persisted file records and clears existing slots without a match', () => {
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
  assert.equal(result.archivos.archivo2, null);
  assert.equal(result.summary.found, 1);
  assert.equal(result.summary.missing, 3);
  assert.equal(result.scannedFiles, 1);
});

test('does not store newer-month files in the requested period', async () => {
  const originals = {
    findOne: AgencyMonthlyFiles.findOne,
    findOneAndUpdate: AgencyMonthlyFiles.findOneAndUpdate,
  };
  let monthlyFilter;
  let agencySaved = false;
  const agency = {
    _id: 'agency-1',
    archivos: { carpetaPrincipal: 'root' },
    set(field, value) { if (field === 'archivos') this.archivos = value; },
    async save() { agencySaved = true; },
  };
  const drive = {
    files: {
      async list({ q }) {
        if (q.includes("'root'")) {
          return { data: { files: [
            { id: 'year', name: '2026', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
          ] } };
        }
        if (q.includes("'year'")) {
          return { data: { files: [
            { id: 'october', name: 'Octubre', mimeType: 'application/vnd.google-apps.folder', parents: ['year'] },
          ] } };
        }
        return { data: { files: [
          {
            id: 'october-rep',
            name: 'REP-INS Octubre.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            parents: ['october'],
            size: '1024',
            modifiedTime: '2026-10-20T12:00:00.000Z',
          },
        ] } };
      },
    },
  };
  AgencyMonthlyFiles.findOne = () => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => null,
  });

  test('selects only the requested month even when Drive has a newer month', () => {
    const files = [
      { id: 'rep-september', name: 'REP-INS Septiembre.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['september'], folderPath: ['2026', 'Septiembre'], path: '2026/Septiembre/REP-INS Septiembre.xlsx' },
      { id: 'rep-october', name: 'REP-INS Octubre.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['october'], folderPath: ['2026', 'Octubre'], path: '2026/Octubre/REP-INS Octubre.xlsx' },
    ];

    const result = buildAgencyRefresh(
      { entidadFederativa: 'Nuevo León', archivos: {} },
      files,
      2026,
      9,
    );

    assert.deepEqual(result.period, { year: 2026, month: 9 });
    assert.equal(result.archivos.archivo3.driveId, 'rep-september');
  });
  AgencyMonthlyFiles.findOneAndUpdate = async (filter) => {
    monthlyFilter = filter;
    return {};
  };

  try {
    const update = await refreshAgencyFromDrive(agency, drive, 2026, 9);
    assert.deepEqual(monthlyFilter, { agencyId: 'agency-1', period: '2026-09' });
    assert.deepEqual(update.period, { year: 2026, month: 9 });
    assert.equal(update.archivos.archivo3, null);
    assert.equal(agencySaved, false);
  } finally {
    AgencyMonthlyFiles.findOne = originals.findOne;
    AgencyMonthlyFiles.findOneAndUpdate = originals.findOneAndUpdate;
  }
});
