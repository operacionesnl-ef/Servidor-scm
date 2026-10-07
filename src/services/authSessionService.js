const crypto = require('node:crypto');
const AuthSession = require('../models/AuthSession');

const SESSION_COOKIE_NAME = '__Host-efcore.session';
const ABSOLUTE_SESSION_MS = 12 * 60 * 60 * 1000;
const IDLE_SESSION_MS = 30 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getSessionCookieOptions(maxAge = ABSOLUTE_SESSION_MS) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}

function getSessionCookieClearOptions() {
  const { maxAge, ...options } = getSessionCookieOptions(0);
  return options;
}

function readSessionCookie(request) {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;
  const prefix = `${SESSION_COOKIE_NAME}=`;
  const entry = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!entry) return null;
  const value = entry.slice(prefix.length);
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}

async function createAuthSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_SESSION_MS);
  const expiresAt = new Date(Math.min(now.getTime() + IDLE_SESSION_MS, absoluteExpiresAt.getTime()));

  await AuthSession.create({
    userId,
    tokenHash: hashSessionToken(token),
    lastActivityAt: now,
    absoluteExpiresAt,
    expiresAt,
  });

  return { token, maxAge: ABSOLUTE_SESSION_MS };
}

async function findAndTouchAuthSession(token) {
  const now = new Date();
  const session = await AuthSession.findOne({
    tokenHash: hashSessionToken(token),
    expiresAt: { $gt: now },
    absoluteExpiresAt: { $gt: now },
  });
  if (!session) return null;

  if (now.getTime() - session.lastActivityAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    const expiresAt = new Date(Math.min(
      now.getTime() + IDLE_SESSION_MS,
      session.absoluteExpiresAt.getTime(),
    ));
    session.lastActivityAt = now;
    session.expiresAt = expiresAt;
    await session.save();
  }

  return session;
}

async function revokeAuthSession(token) {
  if (!token) return;
  await AuthSession.deleteOne({ tokenHash: hashSessionToken(token) });
}

module.exports = {
  ABSOLUTE_SESSION_MS,
  IDLE_SESSION_MS,
  SESSION_COOKIE_NAME,
  createAuthSession,
  findAndTouchAuthSession,
  getSessionCookieClearOptions,
  getSessionCookieOptions,
  hashSessionToken,
  readSessionCookie,
  revokeAuthSession,
};
