const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const http = require('node:http');
const { OAuth2Client } = require('google-auth-library');
const User = require('../src/models/User');
const ServerEvent = require('../src/models/ServerEvent');
const { googleDesktopLogin, isLoopbackRedirectUri } = require('../src/controllers/authController');
const authRoutes = require('../src/routes/authRoutes');

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('accepts only the desktop loopback callback shape', () => {
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1:43210/'), true);
  assert.equal(isLoopbackRedirectUri('http://localhost:43210/'), false);
  assert.equal(isLoopbackRedirectUri('https://127.0.0.1:43210/'), false);
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1:43210/other'), false);
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1:0/'), false);
});

test('exchanges a PKCE authorization code, verifies desktop audience, and issues an app session', async () => {
  const originals = {
    getToken: OAuth2Client.prototype.getToken,
    verifyIdToken: OAuth2Client.prototype.verifyIdToken,
    findOne: User.findOne,
    eventCreate: ServerEvent.create,
    clientId: process.env.GOOGLE_DESKTOP_CLIENT_ID,
    jwtSecret: process.env.JWT_SECRET,
  };
  let exchanged;
  let verified;
  const user = {
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    nombre: 'Ana',
    correo: 'ana@example.com',
    rol: 'admin',
    status: 'activo',
    set: () => {},
    save: async () => {},
  };
  process.env.GOOGLE_DESKTOP_CLIENT_ID = 'desktop.apps.googleusercontent.com';
  process.env.JWT_SECRET = 'desktop-auth-test-secret';
  OAuth2Client.prototype.getToken = async function getToken(options) {
    exchanged = { clientId: this._clientId, clientSecret: this._clientSecret, ...options };
    return { tokens: { id_token: 'verified-id-token', access_token: 'gmail-access-token' } };
  };
  OAuth2Client.prototype.verifyIdToken = async (options) => {
    verified = options;
    return { getPayload: () => ({ email: 'ana@example.com', email_verified: true }) };
  };
  User.findOne = async () => user;
  ServerEvent.create = async () => ({});

  try {
    const response = createResponse();
    await googleDesktopLogin({
      body: {
        code: 'one-time-code',
        codeVerifier: 'A'.repeat(43),
        redirectUri: 'http://127.0.0.1:43210/',
      },
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 200);
    assert.equal(exchanged.clientId, process.env.GOOGLE_DESKTOP_CLIENT_ID);
    assert.equal(exchanged.clientSecret, undefined);
    assert.equal(exchanged.code, 'one-time-code');
    assert.equal(exchanged.codeVerifier, 'A'.repeat(43));
    assert.equal(exchanged.redirect_uri, 'http://127.0.0.1:43210/');
    assert.deepEqual(verified, {
      idToken: 'verified-id-token',
      audience: process.env.GOOGLE_DESKTOP_CLIENT_ID,
    });
    assert.equal(response.body.user.correo, 'ana@example.com');
    assert.equal(response.body.googleAccessToken, 'gmail-access-token');
    assert.ok(response.body.token);
  } finally {
    OAuth2Client.prototype.getToken = originals.getToken;
    OAuth2Client.prototype.verifyIdToken = originals.verifyIdToken;
    User.findOne = originals.findOne;
    ServerEvent.create = originals.eventCreate;
    if (originals.clientId === undefined) delete process.env.GOOGLE_DESKTOP_CLIENT_ID;
    else process.env.GOOGLE_DESKTOP_CLIENT_ID = originals.clientId;
    if (originals.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originals.jwtSecret;
  }
});

test('rejects invalid loopback callback or PKCE values before exchanging a code', async () => {
  const response = createResponse();
  await googleDesktopLogin({
    body: {
      code: 'one-time-code',
      codeVerifier: 'too-short',
      redirectUri: 'https://attacker.example/',
    },
  }, response, (error) => { throw error; });
  assert.equal(response.statusCode, 400);
});

test('reports a safe Google error code when the authorization code exchange is rejected', async () => {
  const original = {
    getToken: OAuth2Client.prototype.getToken,
    clientId: process.env.GOOGLE_DESKTOP_CLIENT_ID,
    jwtSecret: process.env.JWT_SECRET,
  };
  process.env.GOOGLE_DESKTOP_CLIENT_ID = 'desktop.apps.googleusercontent.com';
  process.env.JWT_SECRET = 'desktop-auth-test-secret';
  OAuth2Client.prototype.getToken = async () => {
    const error = new Error('Sensitive request contents must not be returned');
    error.response = { data: { error: 'invalid_grant', error_description: 'authorization code already used' } };
    throw error;
  };

  try {
    const response = createResponse();
    await googleDesktopLogin({
      body: {
        code: 'one-time-code',
        codeVerifier: 'A'.repeat(43),
        redirectUri: 'http://127.0.0.1:43210/',
      },
    }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 401);
    assert.match(response.body.message, /invalid_grant/);
    assert.doesNotMatch(response.body.message, /already used|Sensitive/);
  } finally {
    OAuth2Client.prototype.getToken = original.getToken;
    if (original.clientId === undefined) delete process.env.GOOGLE_DESKTOP_CLIENT_ID;
    else process.env.GOOGLE_DESKTOP_CLIENT_ID = original.clientId;
    if (original.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original.jwtSecret;
  }
});

test('registers POST /api/auth/google/desktop in the auth router', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/google/desktop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      message: 'Desktop Google authorization response is invalid',
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
