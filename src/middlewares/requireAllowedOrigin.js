const { isAllowedOrigin } = require('../config/security');

function requireAllowedOrigin(req, res, next) {
  if (!isAllowedOrigin(req.get('origin'))) {
    return res.status(403).json({ message: 'Origen de solicitud no autorizado.' });
  }
  return next();
}

module.exports = requireAllowedOrigin;
