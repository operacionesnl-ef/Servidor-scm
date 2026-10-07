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

test('adds multiple CC and BCC addresses to their corresponding headers', () => {
  const raw = buildRawMessage({
    to: 'agency@example.com',
    cc: ['cc-one@example.com', 'cc-two@example.com'],
    cco: ['hidden-one@example.com', 'hidden-two@example.com'],
    subject: 'subject',
    text: 'message',
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');

  assert.match(decoded, /Cc: cc-one@example\.com, cc-two@example\.com/);
  assert.match(decoded, /Bcc: hidden-one@example\.com, hidden-two@example\.com/);
});

test('does not add empty CC or BCC headers', () => {
  const decoded = Buffer.from(buildRawMessage({
    to: 'agency@example.com',
    subject: 'subject',
    text: 'message',
  }), 'base64url').toString('utf8');

  assert.doesNotMatch(decoded, /^Cc:/m);
  assert.doesNotMatch(decoded, /^Bcc:/m);
});