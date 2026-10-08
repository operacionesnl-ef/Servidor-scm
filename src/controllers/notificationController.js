'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyRefreshJob = require('../models/AgencyRefreshJob');
const GlobalSetting = require('../models/GlobalSetting');
const MailJob = require('../models/MailJob');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { subscribeToNotificationChanges } = require('../services/notificationEvents');
const {
  buildNotificationFeed,
  getMexicoPeriod,
} = require('../utils/notificationUtils');

const ACTIVE_STATUSES = ['queued', 'processing'];
const RECENT_COMPLETION_DAYS = 7;
const MAX_QUICK_VIEW_HIDDEN_NOTIFICATIONS = 1000;
const REMINDER_ID_PATTERN = /^reminder:\d{4}-\d{2}:[a-f\d]{24}$/i;
const JOB_ID_PATTERN = /^job:(refresh|integrity|mail):[a-f\d]{24}$/i;

function isQuickViewNotificationId(id) {
  return mongoose.isValidObjectId(id) || REMINDER_ID_PATTERN.test(id) || JOB_ID_PATTERN.test(id);
}

function streamNotificationEvents(req, res) {
  res.status(200);
  res.set({
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');

  const sendChange = () => {
    if (!res.destroyed) res.write('event: change\ndata: {}\n\n');
  };
  const unsubscribe = subscribeToNotificationChanges(sendChange);
  sendChange();
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': keep-alive\n\n');
  }, 20000);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.once('close', cleanup);
}

async function getNotifications(req, res, next) {
  try {
    const userId = req.user._id;
    const isAdmin = ['admin', 'developer'].includes(req.user.rol);
    const now = new Date();
    const savedPeriod = await GlobalSetting.findById('agency-search-period').lean();
    const period = savedPeriod || getMexicoPeriod(now);
    const [agencies, announcements, refreshJobs, mailJobs] = await Promise.all([
      Agency.find({ status: 'activa' })
        .select('_id nombre archivos')
        .lean(),
      Notification.find({
        expiresAt: { $gt: now },
        audience: isAdmin ? { $in: ['all', 'admin'] } : 'all',
      }).sort({ createdAt: -1 }).limit(100).lean(),
      AgencyRefreshJob.find({
        ...(isAdmin ? {} : { owner: userId }),
        $or: [
          { status: { $in: ACTIVE_STATUSES } },
          { updatedAt: { $gte: new Date(now.getTime() - RECENT_COMPLETION_DAYS * 86400000) } },
        ],
      }).select('ownerEmail jobType status year month total completed currentName createdAt updatedAt')
        .sort({ updatedAt: -1 }).limit(30).lean(),
      MailJob.find({
        ...(isAdmin ? {} : { owner: userId }),
        $or: [
          { status: { $in: ACTIVE_STATUSES } },
          { updatedAt: { $gte: new Date(now.getTime() - RECENT_COMPLETION_DAYS * 86400000) } },
        ],
      }).select('ownerEmail status year month total completed currentName templateName createdAt updatedAt')
        .sort({ updatedAt: -1 }).limit(30).lean(),
    ]);

    const feed = buildNotificationFeed({
      agencies,
      announcements,
      refreshJobs,
      mailJobs,
      userId,
      period,
    });
    const readIds = new Set(req.user.readNotificationIds || []);
    const hiddenIds = new Set(req.user.quickViewHiddenNotifications || []);
    const items = feed.items.map((item) => (
      item.category === 'reminder' && readIds.has(item.id)
        ? { ...item, read: true }
        : item
    ));
    const unreadCount = items.filter((item) => (
      item.category === 'reminder' && !item.read
    )).length + feed.counts.unreadAnnouncements;
    const visibleItems = req.query?.view === 'quick'
      ? [
        ...items.filter((item) => !item.read && !hiddenIds.has(item.id)),
        ...items
          .filter((item) => item.read && !hiddenIds.has(item.id))
          .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
          .slice(0, 3),
      ]
      : items;

    return res.json({
      ...feed,
      items: visibleItems,
      unreadCount,
      period: { ...period, label: `${String(period.month).padStart(2, '0')}/${period.year}` },
    });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const notificationId = req.params.id;
    if (REMINDER_ID_PATTERN.test(notificationId)) {
      await User.updateOne(
        { _id: req.user._id },
        { $addToSet: { readNotificationIds: notificationId } },
      );
      return res.json({ success: true });
    }
    if (!mongoose.isValidObjectId(notificationId)) {
      return res.status(404).json({ message: 'No se encontró la notificación.' });
    }
    const notification = await Notification.findOneAndUpdate(
      {
        _id: notificationId,
        audience: { $in: ['all', ...(['admin', 'developer'].includes(req.user.rol) ? ['admin'] : [])] },
      },
      { $addToSet: { readBy: req.user._id } },
      { new: true },
    );
    if (!notification) return res.status(404).json({ message: 'No se encontró la notificación.' });
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
}

async function hideNotificationFromQuickView(req, res, next) {
  try {
    const notificationId = req.params.id;
    if (!isQuickViewNotificationId(notificationId)) {
      return res.status(404).json({ message: 'No se encontró la notificación.' });
    }
    const hiddenIds = req.user.quickViewHiddenNotifications || [];
    if (hiddenIds.includes(notificationId)) return res.json({ success: true });
    if (hiddenIds.length >= MAX_QUICK_VIEW_HIDDEN_NOTIFICATIONS) {
      return res.status(409).json({ message: 'Alcanzaste el límite de notificaciones ocultas en la vista rápida.' });
    }
    await User.updateOne(
      { _id: req.user._id },
      { $addToSet: { quickViewHiddenNotifications: notificationId } },
    );
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
}

async function markAllNotificationsRead(req, res, next) {
  try {
    const isAdmin = ['admin', 'developer'].includes(req.user.rol);
    const result = await Notification.updateMany(
      { audience: isAdmin ? { $in: ['all', 'admin'] } : 'all', readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } },
    );
    return res.json({ success: true, updated: result.modifiedCount });
  } catch (error) {
    return next(error);
  }
}

async function publishGlobalNotification(req, res, next) {
  try {
    const { title, message, severity = 'low', audience = 'all' } = req.body || {};
    if (
      typeof title !== 'string' || !title.trim() || title.trim().length > 160 ||
      typeof message !== 'string' || !message.trim() || message.trim().length > 2000 ||
      !['low', 'medium', 'high'].includes(severity) ||
      !['all', 'admin'].includes(audience)
    ) {
      return res.status(400).json({ message: 'Indica un título, mensaje, gravedad y audiencia válidos.' });
    }

    const notification = await Notification.create({
      title: title.trim(),
      message: message.trim(),
      severity,
      audience,
      createdBy: req.user._id,
    });
    return res.status(201).json({
      id: String(notification._id),
      title: notification.title,
      message: notification.message,
      severity: notification.severity,
      audience: notification.audience,
      createdAt: notification.createdAt,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getNotifications,
  hideNotificationFromQuickView,
  markAllNotificationsRead,
  markNotificationRead,
  publishGlobalNotification,
  streamNotificationEvents,
};
