const express = require('express');
const { googleLogin, googleDesktopLogin } = require('../controllers/authController');

const router = express.Router();

router.post('/google', googleLogin);
router.post('/google/desktop', googleDesktopLogin);

module.exports = router;