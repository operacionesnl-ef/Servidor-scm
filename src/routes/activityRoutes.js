const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const requireDeveloper = require('../middlewares/requireDeveloper');
const { getServerLogs } = require('../controllers/serverLogController');
const {
	getActivity,
	getActivityById,
	getSystemActivity,
	restoreActivity,
} = require('../controllers/activityController');

const router = express.Router();

router.get('/', requireAuth, getActivity);
router.get('/system', requireAuth, getSystemActivity);
router.get('/server', requireAuth, requireDeveloper, getServerLogs);
router.get('/:id', requireAuth, getActivityById);
router.post('/:id/restore', requireAuth, restoreActivity);

module.exports = router;