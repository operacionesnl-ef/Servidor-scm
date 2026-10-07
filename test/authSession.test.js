const assert = require('node:assert/strict');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const AuthSession = require('../src/models/AuthSession');
const User = require('../src/models/User');
const ServerEvent = require('../src/models/ServerEvent');
const requireAuth = require('../src/middlewares/requireAuth');
const requireAllowedOrigin = require('../src/middlewares/requireAllowedOrigin');
const {
  googleLogin,
  googleSessionLogin,
  getCurrentSession,
  logoutSession,
} = require('../src/controllers/authController');
const {
  ABSOLUTE_SESSION_MS,
  IDLE_SESSION_MS,
  SESSION_COOKIE_NAME,
  createAuthSession,
  findAndTouchAuthSession,
  getSessionCookieOptions,
  hashSessionToken,
  revokeAuthSession,
} = require('../src/services/authSessionService');

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    cookies: [],
    clearedCookies: [],
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.clearedCookies.push({ name, options }); return this; },
    end() { this.ended = true; return this; },
  };
}

test('stores only a hash and applies temporary idle and absolute expiry to each session', async () => {
  const originalCreate = AuthSession.create;
  let stored;
  AuthSession.create = async (record) => { stored = record; };
  try {
    const session = await createAuthSession('507f1f77bcf86cd799439011');
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(stored.tokenHash, session.token);
    assert.equal(stored.tokenHash, hashSessionToken(session.token));
    assert.equal(stored.expiresAt.getTime() - stored.lastActivityAt.getTime(), IDLE_SESSION_MS);
    assert.equal(stored.absoluteExpiresAt.getTime() - stored.lastActivityAt.getTime(), ABSOLUTE_SESSION_MS);
  } finally {
    AuthSession.create = originalCreate;
  }
});

test('touches active sessions but does not extend beyond their absolute expiry', async () => {
  const originalFindOne = AuthSession.findOne;
  const now = Date.now();
  const session = {
    lastActivityAt: new Date(now - 2 * 60 * 1000),
    absoluteExpiresAt: new Date(now + 5 * 60 * 1000),
    save: async () => {},
  };
  let query;
  AuthSession.findOne = async (filter) => { query = filter; return session; };
  try {
    assert.equal(await findAndTouchAuthSession('raw-session-token'), session);
    assert.equal(query.tokenHash, hashSessionToken('raw-session-token'));
    assert.equal(query.expiresAt.$gt instanceof Date, true);
    assert.equal(session.lastActivityAt.getTime() >= now, true);
    assert.equal(session.expiresAt.getTime(), session.absoluteExpiresAt.getTime());
  } finally {
    AuthSession.findOne = originalFindOne;
  }
});

test('refuses sessions after idle or absolute expiry', async () => {
  const originalFindOne = AuthSession.findOne;
  let query;
  AuthSession.findOne = async (filter) => { query = filter; return null; };
  try {
    assert.equal(await findAndTouchAuthSession('expired-token'), null);
    assert.equal(query.expiresAt.$gt instanceof Date, true);
    assert.equal(query.absoluteExpiresAt.$gt instanceof Date, true);
  } finally {
    AuthSession.findOne = originalFindOne;
  }
});

test('sets a Secure, HttpOnly, host-only cookie and revokes by token hash', async () => {
  const options = getSessionCookieOptions();
  assert.deepEqual(options, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ABSOLUTE_SESSION_MS,
  });
  const originalDeleteOne = AuthSession.deleteOne;
  let query;
  AuthSession.deleteOne = async (filter) => { query = filter; };
  try {
    await revokeAuthSession('logout-token');
    assert.deepEqual(query, { tokenHash: hashSessionToken('logout-token') });
  } finally {
    AuthSession.deleteOne = originalDeleteOne;
  }
});

test('web Google session login creates a cookie and does not return a bearer token', async () => {
  const originals = {
    verifyIdToken: OAuth2Client.prototype.verifyIdToken,
    findOne: User.findOne,
    createSession: AuthSession.create,
    eventCreate: ServerEvent.create,
    clientId: process.env.GOOGLE_CLIENT_ID,
  };
  const user = {
    _id: '507f1f77bcf86cd799439011',
    nombre: 'Ana',
    correo: 'ana@example.com',
    rol: 'admin',
    status: 'activo',
    set: () => {},
    save: async () => {},
  };
  let storedSession;
  OAuth2Client.prototype.verifyIdToken = async () => ({
    getPayload: () => ({ email: 'ana@example.com', email_verified: true }),
  });
  User.findOne = async () => user;
  AuthSession.create = async (record) => { storedSession = record; };
  ServerEvent.create = async () => ({});
  process.env.GOOGLE_CLIENT_ID = 'web.apps.googleusercontent.com';

  try {
    const response = createResponse();
    await googleSessionLogin({ body: { idToken: 'google-id-token' } }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.user, {
      _id: user._id,
      nombre: user.nombre,
      correo: user.correo,
      rol: user.rol,
      status: user.status,
    });
    assert.equal(Object.hasOwn(response.body, 'token'), false);
    assert.equal(response.cookies[0].name, SESSION_COOKIE_NAME);
    assert.notEqual(response.cookies[0].value, storedSession.tokenHash);
    assert.equal(response.cookies[0].options.httpOnly, true);
    assert.equal(response.cookies[0].options.secure, true);
  } finally {
    OAuth2Client.prototype.verifyIdToken = originals.verifyIdToken;
    User.findOne = originals.findOne;
    AuthSession.create = originals.createSession;
    ServerEvent.create = originals.eventCreate;
    if (originals.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originals.clientId;
  }
});

test('legacy web login issues only migration-tagged bearer tokens', async () => {
  const originals = {
    verifyIdToken: OAuth2Client.prototype.verifyIdToken,
    findOne: User.findOne,
    eventCreate: ServerEvent.create,
    clientId: process.env.GOOGLE_CLIENT_ID,
    jwtSecret: process.env.JWT_SECRET,
  };
  const user = {
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    nombre: 'Ana',
    correo: 'ana@example.com',
    rol: 'user',
    status: 'activo',
    set: () => {},
    save: async () => {},
  };
  OAuth2Client.prototype.verifyIdToken = async () => ({
    getPayload: () => ({ email: 'ana@example.com', email_verified: true }),
  });
  User.findOne = async () => user;
  ServerEvent.create = async () => ({});
  process.env.GOOGLE_CLIENT_ID = 'web.apps.googleusercontent.com';
  process.env.JWT_SECRET = 'legacy-session-migration-secret';

  try {
    const response = createResponse();
    await googleLogin({ body: { idToken: 'google-id-token' } }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 200);
    assert.equal(jwt.decode(response.body.token).client, 'legacy');
    assert.equal(response.cookies.length, 0);
  } finally {
    OAuth2Client.prototype.verifyIdToken = originals.verifyIdToken;
    User.findOne = originals.findOne;
    ServerEvent.create = originals.eventCreate;
    if (originals.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originals.clientId;
    if (originals.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originals.jwtSecret;
  }
});

test('accepts only configured browser origins for login and rejects cross-site mutations', async () => {
  const deniedResponse = createResponse();
  let continued = false;
  requireAllowedOrigin({ get: () => 'https://attacker.example' }, deniedResponse, () => { continued = true; });
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(continued, false);

  const originalFind = AuthSession.findOne;
  const originalFindUser = User.findById;
  AuthSession.findOne = async () => ({
    lastActivityAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
    save: async () => {},
  });
  User.findById = async () => ({ status: 'activo' });
  try {
    const response = createResponse();
    const request = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=valid-session-token` },
      method: 'POST',
      get: () => 'https://attacker.example',
    };
    await requireAuth(request, response, () => { continued = true; });
    assert.equal(response.statusCode, 403);
    assert.equal(continued, false);

    const allowedRequest = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=valid-session-token` },
      method: 'POST',
      get: () => 'https://0sj2cvrmofimguhvqrrmcmasqex7uqfvc8yc3.netlify.app',
    };
    const allowedResponse = createResponse();
    await requireAuth(allowedRequest, allowedResponse, () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(allowedRequest.user.status, 'activo');
  } finally {
    AuthSession.findOne = originalFind;
    User.findById = originalFindUser;
  }
});

test('rejects pre-migration and desktop bearer tokens', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  process.env.JWT_SECRET = 'session-migration-test-secret';
  User.findById = async () => ({ status: 'activo' });
  try {
    const legacyToken = jwt.sign({ sub: 'user-1' }, process.env.JWT_SECRET);
    const legacyResponse = createResponse();
    await requireAuth({
      headers: { authorization: `Bearer ${legacyToken}` },
      method: 'GET',
    }, legacyResponse, () => assert.fail('legacy token must not authenticate'));
    assert.equal(legacyResponse.statusCode, 401);

    const desktopToken = jwt.sign({ sub: 'user-1', client: 'desktop' }, process.env.JWT_SECRET);
    const desktopResponse = createResponse();
    let continued = false;
    await requireAuth({
      headers: { authorization: `Bearer ${desktopToken}` },
      method: 'GET',
    }, desktopResponse, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(desktopResponse.statusCode, 401);
  } finally {
    User.findById = originalFindById;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});

test('session endpoint returns the current user and logout clears and revokes its cookie', async () => {
  const user = {
    _id: '507f1f77bcf86cd799439011',
    nombre: 'Ana',
    correo: 'ana@example.com',
    rol: 'user',
    status: 'activo',
  };
  const sessionResponse = createResponse();
  getCurrentSession({ user }, sessionResponse);
  assert.equal(sessionResponse.body.user.correo, user.correo);

  const originalDeleteOne = AuthSession.deleteOne;
  let deletedQuery;
  AuthSession.deleteOne = async (filter) => { deletedQuery = filter; };
  try {
    const response = createResponse();
    await logoutSession({
      headers: { cookie: `${SESSION_COOKIE_NAME}=logout-token` },
    }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 204);
    assert.equal(response.ended, true);
    assert.equal(response.clearedCookies[0].name, SESSION_COOKIE_NAME);
    assert.deepEqual(deletedQuery, { tokenHash: hashSessionToken('logout-token') });
  } finally {
    AuthSession.deleteOne = originalDeleteOne;
  }
});
