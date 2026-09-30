const express = require('express');
const router = express.Router();

const authRoutes = require('./authRoutes');
const agencyRoutes = require('./agencyRoutes');
const gmailRoutes = require('./gmailRoutes');
const userRoutes = require('./userRoutes');

router.use('/auth', authRoutes);
router.use('/agencies', agencyRoutes);
router.use('/gmail', gmailRoutes);
router.use('/users', userRoutes);

module.exports = router;
