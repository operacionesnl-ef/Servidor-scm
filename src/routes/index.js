const express = require('express');
const router = express.Router();

const authRoutes = require('./authRoutes');
const agencyRoutes = require('./agencyRoutes');
const activityRoutes = require('./activityRoutes');
const gmailRoutes = require('./gmailRoutes');
const mailJobRoutes = require('./mailJobRoutes');
const maillogRoutes = require('./maillogRoutes');
const userRoutes = require('./userRoutes');
const templateRoutes = require('./templateRoutes');
const notificationRoutes = require('./notificationRoutes');
const adminRoutes = require('./adminRoutes');
const calendarRoutes = require('./calendarRoutes');


router.use('/templates', templateRoutes);
router.use('/auth', authRoutes);
router.use('/agencies', agencyRoutes);
router.use('/activity', activityRoutes);
router.use('/gmail', gmailRoutes);
router.use('/mail-jobs', mailJobRoutes);
router.use('/maillogs', maillogRoutes);
router.use('/users', userRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin', adminRoutes);
router.use('/calendar', calendarRoutes);

module.exports = router;
