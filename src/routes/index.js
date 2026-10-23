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
const googleDriveRoutes = require('./googleDriveRoutes');
const forReportRoutes = require('./forReportRoutes');
const requireAuth = require('../middlewares/requireAuth');

const denyConsultor = (req, res, next) => {
  if (req.user?.rol === 'consultor') {
    return res.status(403).json({ success: false, message: 'Tu rol no tiene acceso a esta sección.' });
  }
  return next();
};

router.use('/templates', requireAuth, denyConsultor, templateRoutes);
router.use('/auth', authRoutes);
router.use('/agencies', agencyRoutes);
router.use('/activity', requireAuth, denyConsultor, activityRoutes);
router.use('/gmail', requireAuth, denyConsultor, gmailRoutes);
router.use('/mail-jobs', requireAuth, denyConsultor, mailJobRoutes);
router.use('/maillogs', requireAuth, denyConsultor, maillogRoutes);
router.use('/users', requireAuth, denyConsultor, userRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin', requireAuth, denyConsultor, adminRoutes);
router.use('/calendar', calendarRoutes);
router.use('/google-drive', googleDriveRoutes);
router.use('/for-aud-amb', forReportRoutes);

module.exports = router;
