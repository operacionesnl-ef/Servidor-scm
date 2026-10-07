'use strict';

const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const requireDeveloper = require('../middlewares/requireDeveloper');
const {
  getNotifications,
  hideNotificationFromQuickView,
  markAllNotificationsRead,
  markNotificationRead,
  publishGlobalNotification,
  streamNotificationEvents,
} = require('../controllers/notificationController');

const router = express.Router();

router.use(requireAuth);
router.get('/events', streamNotificationEvents);
router.get('/', getNotifications);
router.patch('/read', markAllNotificationsRead);
router.patch('/quick/:id/hide', hideNotificationFromQuickView);
router.patch('/:id/read', markNotificationRead);
router.post('/broadcast', requireDeveloper, publishGlobalNotification);

module.exports = router;
