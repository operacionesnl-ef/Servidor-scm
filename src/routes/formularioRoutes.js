const express = require('express');
const { rateLimit } = require('express-rate-limit');
const requireAuth = require('../middlewares/requireAuth');
const {
  generateFlyerBackground,
  getFlyerBackgroundImage,
  getFlyerBackgrounds,
  receiveFlyerFiles,
  saveFlyerToDrive,
  selectFlyerBackground,
} = require('../controllers/flyerController');
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
const flyerBackgroundLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Se alcanzó el límite de generación de fondos. Inténtalo más tarde.',
  },
});
const flyerDriveSaveLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Se alcanzó el límite de guardados del flyer. Inténtalo más tarde.',
  },
});
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
router.post('/flyer/fondo', flyerBackgroundLimit, generateFlyerBackground);
router.post('/:id/flyer/guardar', flyerDriveSaveLimit, receiveFlyerFiles, saveFlyerToDrive);
router.get('/:id/flyer/fondos', getFlyerBackgrounds);
router.get('/:id/flyer/fondos/:fileId/imagen', getFlyerBackgroundImage);
router.post('/:id/flyer/fondos/seleccionar', selectFlyerBackground);
router.get('/', getFormularios);
router.post('/', requireFormManagement, createFormulario);
router.get('/:id/qr', getFormularioQR);
router.get('/:id/registros', requireFormManagement, getFormularioRegistros);
router.get('/:id/exportar', requireFormManagement, exportFormularioRegistros);
router.post('/:id/cancelar', requireFormManagement, cancelFormulario);
router.get('/:id', getFormulario);
router.put('/:id', requireFormManagement, updateFormulario);

module.exports = router;
