const express = require('express');
const { rateLimit } = require('express-rate-limit');
const {
  getPublicFormulario,
  getPublicMarcas,
  getPublicAgencias,
  createPublicRegistro,
} = require('../controllers/registroPublicoController');

const router = express.Router();
const publicReadLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    code: 'LIMITE_DE_SOLICITUDES',
    message: 'Se alcanzó el límite de consultas. Inténtalo nuevamente más tarde.',
  }),
});
const publicRegistrationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    code: 'LIMITE_DE_REGISTROS',
    message: 'Se alcanzó el límite de intentos. Inténtalo nuevamente más tarde.',
  }),
});

router.use(publicReadLimit);
router.get('/:token', getPublicFormulario);
router.get('/:token/marcas', getPublicMarcas);
router.get('/:token/agencias/:marcaId', getPublicAgencias);
router.post('/:token/registros', publicRegistrationLimit, createPublicRegistro);

module.exports = router;
