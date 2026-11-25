const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const {
  createMailJob,
  getActiveMailJob,
  getMailJob,
  resumeMailJob,
} = require('../controllers/mailJobController');

const router = express.Router();

router.use(requireAuth);
router.post('/', createMailJob);
router.get('/active', getActiveMailJob);
router.post('/:jobId/resume', resumeMailJob);
router.get('/:jobId', getMailJob);

module.exports = router;