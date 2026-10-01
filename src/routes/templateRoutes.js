const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const router  = express.Router();
const {
  getTemplates,
  getMeta,
  getTemplateByKey,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  toggleTemplate,
} = require('../controllers/templateController');

router.use(requireAuth);

/* ── Constantes del modelo (variables, códigos) ── */
router.get('/meta', getMeta);

/* ── CRUD principal ── */
router.get   ('/',          getTemplates);
router.post  ('/',          createTemplate);
router.get   ('/:key',      getTemplateByKey);
router.put   ('/:key',      updateTemplate);
router.delete('/:key',      deleteTemplate);
router.patch ('/:key/toggle', toggleTemplate);

module.exports = router;