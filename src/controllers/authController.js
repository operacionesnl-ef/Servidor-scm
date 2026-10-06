const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { logServerEvent } = require('../utils/serverLogger');

const googleClient = new OAuth2Client();

function isLoopbackRedirectUri(redirectUri) {
  if (typeof redirectUri !== 'string') return false;
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && /^\d+$/.test(url.port)
      && Number(url.port) > 0
      && Number(url.port) <= 65535
      && url.pathname === '/'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

async function completeGoogleLogin(payload, req, res, next, extraResponse = {}) {
  if (!payload?.email || payload.email_verified !== true) {
    return res.status(401).json({ message: 'Google account email is not verified' });
  }

  try {
    const user = await User.findOne({ correo: payload.email.toLowerCase() });
    if (!user || user.status !== 'activo') {
      return res.status(403).json({ message: 'This account is not authorized to access the application' });
    }

    user.set('autenticacion.proveedor', 'google');
    user.set('autenticacion.ultimoAcceso', new Date());
    await user.save();

    const token = jwt.sign(
      { sub: user._id.toString(), correo: user.correo },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    await logServerEvent('session_started', { userId: user._id });
    req.user = user;

    return res.json({
      user: {
        _id: user._id,
        nombre: user.nombre,
        correo: user.correo,
        rol: user.rol,
        status: user.status,
      },
      token,
      ...extraResponse,
    });
  } catch (err) {
    return next(err);
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

const googleDesktopLogin = async (req, res, next) => {
  const { code, codeVerifier, redirectUri } = req.body || {};
  const { GOOGLE_DESKTOP_CLIENT_ID, JWT_SECRET } = process.env;

  if (
    typeof code !== 'string' || !code.trim() ||
    typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) ||
    !isLoopbackRedirectUri(redirectUri)
  ) {
    return res.status(400).json({ message: 'Desktop Google authorization response is invalid' });
  }
  if (!GOOGLE_DESKTOP_CLIENT_ID || !JWT_SECRET) {
    return res.status(500).json({ message: 'Desktop Google authentication is not configured on the server' });
  }

  let payload;
  let googleAccessToken;
  try {
    const oauthClient = new OAuth2Client(GOOGLE_DESKTOP_CLIENT_ID, undefined, redirectUri);
    const { tokens } = await oauthClient.getToken({
      code,
      codeVerifier,
      redirect_uri: redirectUri,
    });
    if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') {
      return res.status(401).json({ message: 'Google did not return the required desktop authorization tokens' });
    }
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_DESKTOP_CLIENT_ID,
    });
    payload = ticket.getPayload();
    googleAccessToken = tokens.access_token;
  } catch (err) {
    return res.status(401).json({ message: 'Google desktop authorization code is invalid or expired' });
  }

  return completeGoogleLogin(payload, req, res, next, { googleAccessToken });
};

module.exports = { googleLogin, googleDesktopLogin, isLoopbackRedirectUri };