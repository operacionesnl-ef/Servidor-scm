'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { formatEvent, formatRequest, progressBar } = require('../src/utils/consoleLogger');

test('renders job progress and status as a readable console event', () => {
  const output = formatEvent('mail_job.recipient', {
    timestamp: '2026-10-06T15:00:00.000Z',
    completed: 2,
    total: 4,
    agency: 'Agencia Norte',
    status: 'sent',
  }, false);

  assert.match(output, /INFO  Resultado de envío/);
  assert.match(output, /\[█████████░░░░░░░░░\] 50%/);
  assert.match(output, /estado: sent/);
  assert.match(output, /agencia: Agencia Norte/);
});

test('formats HTTP logs without ANSI escapes and safely flattens terminal controls', () => {
  const output = formatRequest({
    timestamp: '2026-10-06T15:00:00.000Z',
    method: 'GET',
    path: '/api/status\nFAKE ERROR',
    statusCode: 200,
    durationMs: 24,
    user: { correo: 'ana@example.com' },
    data: { token: '[redacted]' },
  }, false);

  assert.match(output, /GET/);
  assert.match(output, /200/);
  assert.match(output, /24 ms/);
  assert.match(output, /\/api\/status FAKE ERROR/);
  assert.doesNotMatch(output, /\u001b|\nFAKE ERROR/);
});

test('renders safe percentages for empty and bounded progress values', () => {
  assert.equal(progressBar(0, 0), '');
  assert.match(progressBar(-1, 10), /\[░{18}\] 0%/);
  assert.match(progressBar(11, 10), /\[█{18}\] 100%/);
});
