const { randomBytes } = require('crypto');
const { google } = require('googleapis');

const wrapBase64 = (value) => Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';

const createRawMessage = ({ to, subject, text, html }) => {
  const boundary = `scm-${randomBytes(16).toString('hex')}`;
  const encodedSubject = Buffer.from(subject, 'utf8').toString('base64');
  const plainText = wrapBase64(text || '');
  const htmlText = wrapBase64(html || text || '');

  const message = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    plainText,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlText,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return Buffer.from(message, 'utf8').toString('base64url');
};

const sendGmail = async (req, res, next) => {
  const { to, subject, text = '', html = '', googleAccessToken } = req.body || {};

  if (
    typeof to !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim()) ||
    typeof subject !== 'string' ||
    !subject.trim() ||
    /[\r\n]/.test(subject) ||
    (typeof text !== 'string') ||
    (typeof html !== 'string') ||
    (!text && !html) ||
    typeof googleAccessToken !== 'string' ||
    !googleAccessToken.trim()
  ) {
    return res.status(400).json({ message: 'Recipient, subject, message, and Google access token are required' });
  }

  const oauthClient = new google.auth.OAuth2();
  oauthClient.setCredentials({ access_token: googleAccessToken });

  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
    const { data: profile } = await oauth2.userinfo.get();

    if (
      !profile.verified_email ||
      profile.email?.toLowerCase() !== req.user.correo.toLowerCase()
    ) {
      return res.status(403).json({ message: 'The Gmail account must match your signed-in account' });
    }

    const gmail = google.gmail({ version: 'v1', auth: oauthClient });
    const { data } = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: createRawMessage({ to: to.trim(), subject: subject.trim(), text, html }),
      },
    });

    return res.json({
      success: true,
      message: 'Email sent successfully',
      data: { messageId: data.id },
    });
  } catch (err) {
    const status = Number(err.code || err.response?.status);
    if (status === 401) {
      return res.status(401).json({ message: 'Google access expired; authorize Gmail and try again' });
    }
    if (status === 403) {
      return res.status(403).json({ message: 'Gmail API denied access; grant the gmail.send permission and enable Gmail API in Google Cloud' });
    }
    if (status === 400) {
      return res.status(400).json({ message: 'Gmail could not accept this message' });
    }
    return next(err);
  }
};

module.exports = { sendGmail };