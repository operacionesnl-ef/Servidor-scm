const { randomBytes } = require('crypto');

function wrapBase64(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value || '', 'utf8');
  const chunks = [];
  const chunkSize = 57 * 1024;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const encoded = input.subarray(offset, Math.min(offset + chunkSize, input.length)).toString('base64');
    const wrapped = encoded.match(/.{1,76}/g)?.join('\r\n') || '';
    chunks.push(Buffer.from(wrapped, 'ascii'));
  }
  return chunks;
}

function safeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function buildRawMessage({ to, cc = [], bcc = [], cco = [], subject, text, attachments = [] }) {
  const blindCopies = [...bcc, ...cco];
  const boundary = `scm-${randomBytes(16).toString('hex')}`;
  const parts = [];
  const appendLines = (lines) => {
    parts.push(Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'));
  };
  appendLines([
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
  ]);
  parts.push(...wrapBase64(text));

  for (const attachment of attachments) {
    const name = safeHeader(attachment.nombre).replace(/["\\]/g, '_') || 'archivo';
    const encodedName = encodeURIComponent(name);
    parts.push(Buffer.from([
      '',
      `--${boundary}`,
      `Content-Type: ${safeHeader(attachment.mimeType) || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"; filename*=UTF-8''${encodedName}`,
      '',
    ].join('\r\n'), 'utf8'));
    parts.push(...wrapBase64(attachment.content));
  }

  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  const message = Buffer.concat(parts);
  parts.length = 0;
  return message.toString('base64url');
}

module.exports = { buildRawMessage };