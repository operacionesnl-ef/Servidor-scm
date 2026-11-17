const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const {
  getFormularios,
  createFormulario,
  getFormulario,
  updateFormulario,
  cancelFormulario,
  getFormularioQR,
  getFormularioRegistros,
  exportFormularioRegistros,
} = require('../controllers/formularioController');

const router = express.Router();
const requireFormAccess = (req, res, next) => {
  if (!['admin', 'developer', 'organizador'].includes(req.user?.rol)) {
    return res.status(403).json({ success: false, message: 'No tienes permiso para consultar formularios.' });
  }
  return next();
};
const requireFormManagement = (req, res, next) => {
  if (!['admin', 'developer'].includes(req.user?.rol)) {
    return res.status(403).json({ success: false, message: 'Se requiere acceso de administrador o developer.' });
  }
  return next();
};

router.use(requireAuth, requireFormAccess);
router.get('/', getFormularios);
router.post('/', requireFormManagement, createFormulario);
router.get('/:id/qr', getFormularioQR);
router.get('/:id/registros', requireFormManagement, getFormularioRegistros);
router.get('/:id/exportar', requireFormManagement, exportFormularioRegistros);
router.post('/:id/cancelar', requireFormManagement, cancelFormulario);
router.get('/:id', getFormulario);
router.put('/:id', requireFormManagement, updateFormulario);

module.exports = router;
