const assert = require('node:assert/strict');
const { test } = require('node:test');
const { decryptGoogleToken, encryptGoogleToken } = require('../src/utils/mailJobCrypto');

test('encrypts Google tokens and decrypts them with the application secret', () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-with-enough-entropy';
  try {
    const encrypted = encryptGoogleToken('google-access-token');
    assert.notEqual(encrypted, 'google-access-token');
    assert.equal(decryptGoogleToken(encrypted), 'google-access-token');
    assert.throws(() => decryptGoogleToken(`${encrypted.slice(0, -1)}x`));
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});