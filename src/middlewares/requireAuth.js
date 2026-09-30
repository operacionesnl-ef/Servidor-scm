const jwt = require('jsonwebtoken');
const User = require('../models/User');

const requireAuth = async (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Authentication token is required' });
  }

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: 'Authentication token is invalid or expired' });
  }

  if (!claims.sub) {
    return res.status(401).json({ message: 'Authentication token is invalid' });
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