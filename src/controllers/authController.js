const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { logServerEvent } = require('../utils/serverLogger');
const {
  createAuthSession,
  getSessionCookieClearOptions,
  getSessionCookieOptions,
  readSessionCookie,
  revokeAuthSession,
  SESSION_COOKIE_NAME,
} = require('../services/authSessionService');

const googleClient = new OAuth2Client();

async function updateGoogleLoginMetadata(user) {
  const result = await User.updateOne(
    { correo: user.correo, status: 'activo' },
    {
      $set: {
        'autenticacion.proveedor': 'google',
        'autenticacion.ultimoAcceso': new Date(),
      },
    }
  );
  return result.matchedCount === 1;
}

async function completeGoogleLogin(payload, req, res, next) {
  if (!payload?.email || payload.email_verified !== true) {
    return res.status(401).json({ message: 'Google account email is not verified' });
  }

  try {
    const user = await User.findOne({ correo: payload.email.toLowerCase() });
    if (!user || user.status !== 'activo') {
      return res.status(403).json({ message: 'This account is not authorized to access the application' });
    }

    if (!await updateGoogleLoginMetadata(user)) {
      return res.status(403).json({ message: 'This account is not authorized to access the application' });
    }

    const token = jwt.sign(
      { sub: user._id.toString(), correo: user.correo, client: 'legacy' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    await logServerEvent('session_started', { userId: user._id });
    req.user = user;

    res.set('Cache-Control', 'no-store, private');
    return res.json({
      user: {
        _id: user._id,
        nombre: user.nombre,
        correo: user.correo,
        rol: user.rol,
        status: user.status,
        canEditForReports: user.canEditForReports === true,
      },
      token,
    });
  } catch (err) {
    return next(err);
  }
}

async function completeGoogleWebLogin(payload, req, res, next) {
  if (!payload?.email || payload.email_verified !== true) {
    return res.status(401).json({ message: 'Google account email is not verified' });
  }

  try {
    const user = await User.findOne({ correo: payload.email.toLowerCase() });
    if (!user || user.status !== 'activo') {
      return res.status(403).json({ message: 'This account is not authorized to access the application' });
    }

    if (!await updateGoogleLoginMetadata(user)) {
      return res.status(403).json({ message: 'This account is not authorized to access the application' });
    }

    const session = await createAuthSession(user.correo, user._id);
    await logServerEvent('session_started', { userId: user._id });
    res.set('Cache-Control', 'no-store, private');
    res.cookie(SESSION_COOKIE_NAME, session.token, getSessionCookieOptions(session.maxAge));
    req.user = user;

    return res.json({
      user: {
        _id: user._id,
        nombre: user.nombre,
        correo: user.correo,
        rol: user.rol,
        status: user.status,
        canEditForReports: user.canEditForReports === true,
      },
    });
  } catch (error) {
    return next(error);
  }
}

const googleLogin = async (req, res, next) => {
  const { idToken } = req.body || {};

  if (typeof idToken !== 'string' || !idToken.trim()) {
    return res.status(400).json({ message: 'Google ID token is required' });
  }

  const { GOOGLE_CLIENT_ID, JWT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !JWT_SECRET) {
    return res.status(500).json({ message: 'Google authentication is not configured on the server' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ message: 'Google credential is invalid or expired' });
  }

  return completeGoogleLogin(payload, req, res, next);
};

const googleSessionLogin = async (req, res, next) => {
  const { idToken } = req.body || {};

  if (typeof idToken !== 'string' || !idToken.trim()) {
    return res.status(400).json({ message: 'Google ID token is required' });
  }

  const { GOOGLE_CLIENT_ID } = process.env;
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ message: 'Google authentication is not configured on the server' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ message: 'Google credential is invalid or expired' });
  }

  return completeGoogleWebLogin(payload, req, res, next);
};

const getCurrentSession = (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  return res.json({
    user: {
      _id: req.user._id,
      nombre: req.user.nombre,
      correo: req.user.correo,
      rol: req.user.rol,
      status: req.user.status,
      canEditForReports: req.user.canEditForReports === true,
    },
  });
};

const logoutSession = async (req, res, next) => {
  try {
    await revokeAuthSession(readSessionCookie(req));
    res.set('Cache-Control', 'no-store, private');
    res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieClearOptions());
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getCurrentSession,
  googleLogin,
  googleSessionLogin,
  logoutSession,
};