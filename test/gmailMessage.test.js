const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildRawMessage } = require('../src/utils/gmailMessage');

test('builds a Gmail-compatible MIME message with text and attachments', () => {
  const raw = buildRawMessage({
    to: 'agency@example.com',
    subject: 'Informe mensual',
    text: 'Hola, {{SUCURSAL}}',
    attachments: [{ nombre: 'reporte.pdf', mimeType: 'application/pdf', content: Buffer.from('pdf-data') }],
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');

  assert.match(decoded, /To: agency@example\.com/);
  assert.match(decoded, /multipart\/mixed/);
  assert.match(decoded, /filename="reporte\.pdf"/);
  assert.match(decoded, /cGRmLWRhdGE=/);
});

test('removes line breaks from email headers', () => {
  const raw = buildRawMessage({ to: 'safe@example.com\r\nBcc: other@example.com', subject: 'subject\nBcc: attacker@example.com', text: 'message' });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');

  assert.match(decoded, /To: safe@example\.com Bcc: other@example\.com/);
  assert.doesNotMatch(decoded, /\r\nBcc: attacker@example\.com/);
});