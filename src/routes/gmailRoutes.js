const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { sendGmail } = require('../controllers/gmailController');

const router = express.Router();

router.post('/send', requireAuth, sendGmail);

module.exports = router;