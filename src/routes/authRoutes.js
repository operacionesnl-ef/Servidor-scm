const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { googleLogin, googleDesktopLogin, googleDesktopDriveToken } = require('../controllers/authController');

const router = express.Router();

router.post('/google', googleLogin);
router.post('/google/desktop', googleDesktopLogin);
router.post('/google/desktop/drive', requireAuth, googleDesktopDriveToken);

module.exports = router;