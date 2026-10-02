const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto');

function getEncryptionKey() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required to protect mail job credentials.');
  return createHash('sha256').update(`scm-mail-job-token:${process.env.JWT_SECRET}`).digest();
}

function encryptGoogleToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptGoogleToken(value) {
  const [encodedIv, encodedTag, encodedToken] = String(value || '').split('.');
  if (!encodedIv || !encodedTag || !encodedToken) throw new Error('Stored Google authorization is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(encodedIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedToken, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encryptGoogleToken, decryptGoogleToken };