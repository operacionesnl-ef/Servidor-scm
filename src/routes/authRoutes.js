const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const requireAllowedOrigin = require('../middlewares/requireAllowedOrigin');
const {
  getCurrentSession,
  googleLogin,
  googleSessionLogin,
  logoutSession,
} = require('../controllers/authController');

const router = express.Router();

router.post('/google', requireAllowedOrigin, googleLogin);
router.post('/google/session', requireAllowedOrigin, googleSessionLogin);
router.get('/session', requireAuth, getCurrentSession);
router.post('/logout', requireAllowedOrigin, logoutSession);

module.exports = router;