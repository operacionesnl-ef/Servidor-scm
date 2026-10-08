'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { buildAttachments } = require('../src/services/mailJobWorker');

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

