'use strict';

module.exports = function requireAdminOrDeveloper(req, res, next) {
  if (!['admin', 'developer'].includes(req.user?.rol)) {
    return res.status(403).json({
      success: false,
      message: 'Se requiere acceso de administrador o developer.',
    });
  }
  return next();
};
