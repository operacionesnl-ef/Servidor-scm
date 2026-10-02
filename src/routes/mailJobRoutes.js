const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { createMailJob, getActiveMailJob, getMailJob } = require('../controllers/mailJobController');

const router = express.Router();

router.use(requireAuth);
router.post('/', createMailJob);
router.get('/active', getActiveMailJob);
router.get('/:jobId', getMailJob);

module.exports = router;