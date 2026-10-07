const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isAllowedOrigin } = require('../config/security');
const {
  SESSION_COOKIE_NAME,
  findAndTouchAuthSession,
  getSessionCookieClearOptions,
  readSessionCookie,
  revokeAuthSession,
} = require('../services/authSessionService');

function reject(response, message) {
  return response.status(401).json({ message });
}

const requireAuth = async (req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  const cookieToken = readSessionCookie(req);
  if (cookieToken) {
    let session;
    try {
      session = await findAndTouchAuthSession(cookieToken);
    } catch (error) {
      return next(error);
    }
    if (!session) {
      res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieClearOptions());
      return reject(res, 'La sesión no es válida o expiró.');
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isAllowedOrigin(req.get('origin'))) {
      return res.status(403).json({ message: 'Origen de solicitud no autorizado.' });
    }

    try {
      const user = await User.findById(session.userId);
      if (!user || user.status !== 'activo') {
        await revokeAuthSession(cookieToken);
        res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieClearOptions());
        return res.status(403).json({ message: 'This account is not authorized to access the application' });
      }
      req.user = user;
      req.authSession = session;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return reject(res, 'Authentication token is required');
  }

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return reject(res, 'Authentication token is invalid or expired');
  }

  if (!claims.sub || claims.client !== 'legacy') {
    return reject(res, 'Authentication token is invalid');
  }

  try {
    const user = await User.findById(claims.sub);
    if (!user || user.status !== 'activo') {
      return res.status(403).json({ message: 'This account is not authorized to access the application' });
    }

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = requireAuth;