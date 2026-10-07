const { randomBytes } = require('crypto');

function wrapBase64(value) {
  return Buffer.from(value).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
}

function safeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function buildRawMessage({ to, cc = [], bcc = [], cco = [], subject, text, attachments = [] }) {
  const blindCopies = [...bcc, ...cco];
  const boundary = `scm-${randomBytes(16).toString('hex')}`;
  const parts = [
    `To: ${safeHeader(to)}`,
    ...(cc.length ? [`Cc: ${cc.map(safeHeader).join(', ')}`] : []),
    ...(blindCopies.length ? [`Bcc: ${blindCopies.map(safeHeader).join(', ')}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(safeHeader(subject), 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(text),
  ];

  for (const attachment of attachments) {
    const name = safeHeader(attachment.nombre).replace(/["\\]/g, '_') || 'archivo';
    const encodedName = encodeURIComponent(name);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${safeHeader(attachment.mimeType) || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"; filename*=UTF-8''${encodedName}`,
      '',
      wrapBase64(attachment.content),
    );
  }

  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n'), 'utf8').toString('base64url');
}

module.exports = { buildRawMessage };