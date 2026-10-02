const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const {
  createMailLog,
  getMailLogs,
  getMailLogById,
  getMailLogByJobId,
  getMailLogsByAgency,
  deleteMailLog,
} = require('../controllers/mailLogController');

const router = express.Router();

router.use(requireAuth);

/* ── Historial por agencia (antes del /:id para evitar colisión) ── */
router.get('/agency/:agencyId', getMailLogsByAgency);
router.get('/job/:jobId', getMailLogByJobId);

/* ── CRUD principal ── */
router.get   ('/',    getMailLogs);
router.post  ('/',    createMailLog);
router.get   ('/:id', getMailLogById);
router.delete('/:id', deleteMailLog);

module.exports = router;