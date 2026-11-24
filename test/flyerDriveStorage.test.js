'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { afterEach, test } = require('node:test');
const {
  getOrCreateFormularioFlyerBackground,
  listFormularioFlyerBackgrounds,
  saveFormularioFlyerFiles,
} = require('../src/formatosGeneradores/flyer/services/flyerDriveStorage');

const originalRootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

afterEach(() => {
  if (originalRootFolderId === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = originalRootFolderId;
});

function makeDrive() {
  let nextId = 0;
  const files = [];
  const operations = [];
  const readStream = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const drive = {
    files: {
      async list({ q }) {
        operations.push({ type: 'list', q });
        const parentId = q.match(/'([^']+)' in parents/)?.[1];
        const name = q.match(/name = '([^']+)'/)?.[1];
        const appProperties = [...q.matchAll(/key='([^']+)' and value='([^']*)'/g)]
          .map(([, key, value]) => [key, value]);
        return {
          data: {
            files: files.filter((file) => (
              (!parentId || file.parents.includes(parentId))
              && (!name || file.name === name)
              && appProperties.every(([key, value]) => file.appProperties?.[key] === value)
            )),
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
          contents: media?.body ? await readStream(media.body) : Buffer.alloc(0),
        };
        files.push(file);
        operations.push({ type: 'create', requestBody, media });
        return { data: file };
      },
      async update(request) {
        operations.push({ type: 'update', request });
        const file = files.find(({ id }) => id === request.fileId);
        file.name = request.requestBody.name;
        file.appProperties = request.requestBody.appProperties;
        file.mimeType = request.media.mimeType;
        file.contents = await readStream(request.media.body);
        return { data: file };
      },
      async get({ fileId, alt }) {
        const file = files.find(({ id }) => id === fileId);
        if (alt === 'media') return { data: Readable.from([file.contents]) };
        return { data: file };
      },
    },
  };
  return { drive, files, operations };
}

test('stores the PNG and PPTX in flyer using course/date names and replaces existing outputs', async () => {
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root-folder';
  const { drive, files, operations } = makeDrive();
  const form = {
    _id: 'form-123',
    tituloCurso: 'Seguridad eléctrica',
    nombreCurso: 'Seguridad eléctrica, DC3 completo',
    configuracionFechas: { fechaCurso: '2026-11-20T16:00:00.000Z' },
  };
  const first = await saveFormularioFlyerFiles(drive, {
    form,
    pptxBuffer: Buffer.from('editable-one'),
    imageBuffer: Buffer.from('image-one'),
  });
  const second = await saveFormularioFlyerFiles(drive, {
    form,
    pptxBuffer: Buffer.from('editable-two'),
    imageBuffer: Buffer.from('image-two'),
  });

  assert.equal(first.folderName, 'flyer');
  assert.deepEqual(files.map(({ name }) => name), [
    'flyer',
    'Seguridad eléctrica-2026-11-20.pptx',
    'Seguridad eléctrica-2026-11-20.png',
  ]);
  assert.equal(first.files.pptx.driveFileId, second.files.pptx.driveFileId);
  assert.equal(first.files.image.driveFileId, second.files.image.driveFileId);
  assert.deepEqual(files[1].parents, ['drive-1']);
  assert.deepEqual(files[2].parents, ['drive-1']);
  assert.equal(files[1].appProperties.efcoreFlyerFormat, 'pptx');
  assert.equal(files[2].appProperties.efcoreFlyerFormat, 'png');
  assert.equal(operations.filter(({ type }) => type === 'create').length, 3);
  assert.equal(operations.filter(({ type }) => type === 'update').length, 2);
});

test('reuses the saved background unless regeneration is explicitly requested', async () => {
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root-folder';
  const { drive, files, operations } = makeDrive();
  const form = {
    _id: 'form-456',
    tituloCurso: 'Seguridad eléctrica',
    nombreCurso: 'Seguridad eléctrica, DC3 completo',
    norma: 'NOM-029-STPS-2011',
    configuracionFechas: { fechaCurso: '2026-11-20T16:00:00.000Z' },
  };
  const firstImage = Buffer.from([0xff, 0xd8, 0x11, 0xd9]);
  const regeneratedImage = Buffer.from([0xff, 0xd8, 0x22, 0xd9]);
  const updatedForm = {
    ...form,
    tituloCurso: 'Seguridad actualizada',
    norma: 'NOM-035-STPS-2018',
    configuracionFechas: { fechaCurso: '2027-01-15T16:00:00.000Z' },
  };
  let generationCount = 0;
  const generate = async () => {
    generationCount += 1;
    return generationCount === 1 ? firstImage : regeneratedImage;
  };

  const first = await getOrCreateFormularioFlyerBackground(drive, { form, generate });
  const cached = await getOrCreateFormularioFlyerBackground(drive, {
    form: updatedForm,
    generate: async () => assert.fail('No debe generar un fondo que ya existe.'),
  });
  const regenerated = await getOrCreateFormularioFlyerBackground(drive, { form: updatedForm, generate, force: true });

  assert.equal(first.cacheHit, false);
  assert.equal(cached.cacheHit, true);
  assert.deepEqual(cached.buffer, firstImage);
  assert.equal(regenerated.cacheHit, false);
  assert.deepEqual(regenerated.buffer, regeneratedImage);
  assert.equal(generationCount, 2);
  assert.equal(first.driveFileId, files[2].id);
  assert.equal(regenerated.driveFileId, files[3].id);
  assert.equal(files[0].name, 'flyer');
  assert.equal(files[1].name, 'imagenes-fondo');
  assert.match(files[2].name, /^Seguridad eléctrica-2026-11-20-fondo-\d+-[a-f\d]+\.jpg$/);
  assert.match(files[3].name, /^Seguridad actualizada-2027-01-15-fondo-\d+-[a-f\d]+\.jpg$/);
  assert.deepEqual(files[2].parents, ['drive-2']);
  assert.deepEqual(files[3].parents, ['drive-2']);
  assert.deepEqual(files[3].contents, regeneratedImage);
  assert.equal(operations.filter(({ type }) => type === 'update').length, 0);
  const gallery = await listFormularioFlyerBackgrounds(drive, form._id);
  assert.equal(gallery.folderId, 'drive-2');
  assert.deepEqual(gallery.backgrounds.map((image) => image.driveFileId).sort(), [files[2].id, files[3].id].sort());
});
