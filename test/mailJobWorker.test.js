'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const {
  assertGmailRawMessageBytes,
  buildAttachments,
  buildRawMessageWithinLimit,
  classifySendFailure,
  getResumableRecipientIndexes,
  readDriveFile,
} = require('../src/services/mailJobWorker');

test('does not download an attachment larger than the remaining per-message memory budget', async () => {
  const calls = [];
  const drive = {
    files: {
      async get({ alt }) {
        calls.push(alt || 'metadata');
        if (alt === 'media') assert.fail('attachment exceeds the remaining budget');
        return { data: { name: 'large.pdf', mimeType: 'application/pdf', size: '10' } };
      },
    },
  };

  const attachment = await readDriveFile(drive, { driveId: 'drive-file' }, 8);

  assert.equal(attachment.content, null);
  assert.deepEqual(calls, ['metadata']);
});

test('resume candidates exclude sent, uncertain, and non-retryable failed recipients', () => {
  const job = {
    recipients: Array.from({ length: 7 }, () => ({})),
    results: [
      { status: 'sent' },
      { status: 'unknown' },
      { status: 'cancelled' },
      { status: 'failed', retryable: false },
      { status: 'failed', retryable: true },
      { status: 'pending' },
      { status: 'cancelled' },
    ],
  };

  assert.deepEqual(getResumableRecipientIndexes(job), [2, 4, 5, 6]);
});

test('only retries a Gmail request when Gmail explicitly rejected it', () => {
  assert.deepEqual(classifySendFailure(new Error('Drive unavailable'), false), {
    status: 'failed',
    retryable: true,
  });
  assert.deepEqual(classifySendFailure({ response: { status: 429 } }, true), {
    status: 'failed',
    retryable: true,
  });
  assert.deepEqual(classifySendFailure({ code: 401 }, true), {
    status: 'failed',
    retryable: true,
  });
  assert.deepEqual(classifySendFailure({ response: { status: 500 } }, true), {
    status: 'unknown',
    retryable: false,
  });
  assert.deepEqual(classifySendFailure(new Error('Connection reset'), true), {
    status: 'unknown',
    retryable: false,
  });
});

test('rejects encoded Gmail messages above the API size limit before sending', () => {
  assert.throws(
    () => assertGmailRawMessageBytes(25 * 1024 * 1024 + 1),
    /excede el límite de tamaño que acepta Gmail/,
  );
  assert.doesNotThrow(() => assertGmailRawMessageBytes(25 * 1024 * 1024));
});

test('copies oversized files to the auxiliary folder and shares only the copy', async (context) => {
  const originalRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root-folder';
  context.after(() => {
    if (originalRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = originalRoot;
  });

  const calls = [];
  const drive = {
    files: {
      async get({ fileId, alt }) {
        calls.push(['get', fileId, alt]);
        if (alt === 'media') assert.fail('oversized file should not be downloaded');
        return { data: { id: fileId, name: 'large.pdf', mimeType: 'application/pdf', size: String(25 * 1024 * 1024 + 1) } };
      },
      async list(request) {
        calls.push(['list', request.q]);
        return { data: { files: [] } };
      },
      async create(request) {
        calls.push(['folder-create', request.requestBody]);
        return { data: { id: 'aux-folder', name: 'Copias_auxiliares' } };
      },
      async copy(request) {
        calls.push(['copy', request]);
        return { data: { id: 'copy-1', name: 'large.pdf', webViewLink: 'https://drive.google.com/file/d/copy-1/view' } };
      },
    },
    permissions: {
      async list(request) {
        calls.push(['permissions-list', request.fileId]);
        return { data: { permissions: [] } };
      },
      async create(request) {
        calls.push(['permissions-create', request.requestBody]);
        return { data: { id: 'public-reader', type: 'anyone', role: 'reader' } };
      },
    },
  };

  const attachments = await buildAttachments(drive, {
    agencyName: 'Agencia de prueba',
    attachments: [{ code: 'FOR', driveId: 'source-1', nombre: 'large.pdf' }],
  }, []);

  assert.deepEqual(attachments, [{
    nombre: 'large.pdf',
    driveId: 'copy-1',
    driveLink: 'https://drive.google.com/file/d/copy-1/view',
    code: 'FOR',
  }]);
  assert.equal(calls.find(([call]) => call === 'copy')[1].requestBody.parents[0], 'aux-folder');
  assert.deepEqual(calls.find(([call]) => call === 'permissions-create')[1], {
    type: 'anyone',
    role: 'reader',
    allowFileDiscovery: false,
  });
});

test('moves an attachment to Drive when MIME encoding would exceed the 25 MiB message limit', async (context) => {
  const originalRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root-folder';
  context.after(() => {
    if (originalRoot === undefined) delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = originalRoot;
  });

  const drive = {
    files: {
      async list() {
        return { data: { files: [] } };
      },
      async create() {
        return { data: { id: 'aux-folder', name: 'Copias_auxiliares' } };
      },
      async copy() {
        return {
          data: {
            id: 'copy-2',
            name: 'medium.pdf',
            webViewLink: 'https://drive.google.com/file/d/copy-2/view',
          },
        };
      },
    },
    permissions: {
      async list() {
        return { data: { permissions: [] } };
      },
      async create() {
        return { data: { id: 'public-reader', type: 'anyone', role: 'reader' } };
      },
    },
  };
  const { raw, preparedAttachments } = await buildRawMessageWithinLimit(drive, {
    to: 'recipient@example.com',
    subject: 'Test',
    message: 'Body',
    preparedAttachments: [{
      code: 'FOR',
      driveId: 'source-2',
      nombre: 'medium.pdf',
      mimeType: 'application/pdf',
      content: Buffer.alloc(19 * 1024 * 1024),
    }],
  });

  assert.ok(Buffer.from(raw, 'base64url').length <= 25 * 1024 * 1024);
  const mimeMessage = Buffer.from(raw, 'base64url').toString('utf8');
  const encodedText = mimeMessage.match(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/)[1];
  assert.match(Buffer.from(encodedText.replace(/\r\n/g, ''), 'base64').toString('utf8'), /https:\/\/drive\.google\.com\/file\/d\/copy-2\/view/);
  assert.deepEqual(preparedAttachments, [{
    code: 'FOR',
    driveId: 'copy-2',
    nombre: 'medium.pdf',
    driveLink: 'https://drive.google.com/file/d/copy-2/view',
  }]);
});

test('continues preparing attachments when an optional Drive file cannot be read', async () => {
  const drive = {
    files: {
      async get({ fileId, alt }) {
        if (fileId === 'optional-file') throw new Error('Optional file is unavailable.');
        if (alt === 'media') return { data: Readable.from([Buffer.from('report')]) };
        return {
          data: {
            name: 'FOR.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: '6',
          },
        };
      },
    },
  };

  const attachments = await buildAttachments(drive, {
    agencyName: 'Agencia de prueba',
    attachments: [
      { code: 'ANX', driveId: 'optional-file', optional: true },
      { code: 'FOR', driveId: 'required-file', nombre: 'FOR.xlsx' },
    ],
  }, []);

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].code, 'FOR');
  assert.equal(attachments[0].content.toString(), 'report');
});
