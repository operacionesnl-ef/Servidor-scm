const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecoverySnapshot, sanitizeAuditValue } = require('../src/utils/auditSanitizer');

test('redacts credential fields recursively and bounds request data', () => {
  const safe = sanitizeAuditValue({
    googleAccessToken: 'secret-token',
    code: 'oauth-code',
    state: 'oauth-state',
    curp: 'GODE561231HDFRRN09',
    nested: { passwordHash: 'secret-hash', value: 'visible' },
    values: Array.from({ length: 35 }, (_, index) => index),
  });

  assert.equal(safe.googleAccessToken, '[redacted]');
  assert.equal(safe.code, '[redacted]');
  assert.equal(safe.state, '[redacted]');
  assert.equal(safe.curp, '[redacted]');
  assert.equal(safe.nested.passwordHash, '[redacted]');
  assert.equal(safe.nested.value, 'visible');
  assert.equal(safe.values.length, 31);
  assert.match(safe.values.at(-1), /items omitted/);
});

test('keeps a bounded snapshot and rejects one larger than MongoDB audit limit', () => {
  assert.deepEqual(createRecoverySnapshot({ id: 'agency-1', nombre: 'Agencia' }), {
    id: 'agency-1',
    nombre: 'Agencia',
  });
  assert.equal(createRecoverySnapshot({ data: 'x'.repeat(10 * 1024 * 1024 + 1) }), null);
});