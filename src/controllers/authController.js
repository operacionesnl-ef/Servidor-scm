const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const googleClient = new OAuth2Client();

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
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return res.json({
      user: {
        _id: user._id,
        nombre: user.nombre,
        correo: user.correo,
        status: user.status,
      },
      token,
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = { googleLogin };