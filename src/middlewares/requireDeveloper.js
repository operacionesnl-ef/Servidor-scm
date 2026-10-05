'use strict';

module.exports = function requireDeveloper(req, res, next) {
  if (req.user?.rol !== 'developer') {
    return res.status(403).json({ success: false, message: 'Se requiere acceso de developer.' });
  }
  return next();
};
