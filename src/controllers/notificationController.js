'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const AgencyRefreshJob = require('../models/AgencyRefreshJob');
const MailJob = require('../models/MailJob');
const Notification = require('../models/Notification');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const { getAgencyConsultantFilter } = require('../utils/agencyConsultants');
const { subscribeToNotificationChanges } = require('../services/notificationEvents');
const { sendPushToAudience, sendPushToUser } = require('../services/pushNotificationService');
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

async function pushMonthlyReminderOnce(userId, period, count) {
  if (!count || !await Subscription.exists({ userId })) return;

  const periodKey = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const claimed = await User.findOneAndUpdate(
    { _id: userId, lastPushReminderPeriod: { $ne: periodKey } },
    { $set: { lastPushReminderPeriod: periodKey } },
    { new: true },
  );
  if (!claimed) return;

  try {
    const result = await sendPushToUser(userId, {
      title: 'Recordatorio de reportes pendientes',
      body: `Hay ${count} agencia${count === 1 ? '' : 's'} con reportes pendientes para ${String(period.month).padStart(2, '0')}/${period.year}.`,
      url: '/agencias',
      tag: `agency-reminder-${periodKey}`,
    });
    if (!result.sent) {
      await User.updateOne(
        { _id: userId, lastPushReminderPeriod: periodKey },
        { $unset: { lastPushReminderPeriod: 1 } },
      );
    }
  } catch (error) {
    await User.updateOne(
      { _id: userId, lastPushReminderPeriod: periodKey },
      { $unset: { lastPushReminderPeriod: 1 } },
    );
    throw error;
  }
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
  if (res.write('retry: 3000\n\n') === false) {
    res.destroy();
    return;
  }

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const writeEvent = (event) => {
    if (closed || res.destroyed) return;
    if (res.write(event) === false) res.destroy();
  };
  const sendChange = () => {
    writeEvent('event: change\ndata: {}\n\n');
  };
  const unsubscribe = subscribeToNotificationChanges(sendChange);
  const heartbeat = setInterval(() => {
    writeEvent(': keep-alive\n\n');
  }, 20000);
  heartbeat.unref?.();

  res.once('close', cleanup);
}

async function getNotifications(req, res, next) {
  try {
    const userId = req.user._id;
    const isAdmin = ['admin', 'developer'].includes(req.user.rol);
    const isConsultant = req.user.rol === 'consultor';
    const now = new Date();
    const period = getMexicoPeriod(now);
    const [agencies, monthlyRecords, announcements, refreshJobs, mailJobs] = await Promise.all([
      Agency.find({
        status: 'activa',
        ...(isConsultant ? getAgencyConsultantFilter(userId) : {}),
      })
        .select('_id nombre status archivos reviewPeriods')
        .lean(),
      AgencyMonthlyFiles.find({
        period: `${period.year}-${String(period.month).padStart(2, '0')}`,
      }).select('agencyId archivos').lean(),
      Notification.find({
        expiresAt: { $gt: now },
        $or: [
          { audience: isAdmin ? { $in: ['all', 'admin'] } : 'all' },
          { audience: 'personal', recipientUserId: userId },
        ],
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

    const filesByAgency = new Map(monthlyRecords.map((record) => [
      String(record.agencyId),
      record.archivos || {},
    ]));
    const feed = buildNotificationFeed({
      agencies: agencies.map((agency) => ({
        ...agency,
        archivos: filesByAgency.get(String(agency._id)) || {},
      })),
      announcements: isConsultant
        ? announcements.filter((item) => item.audience === 'personal'
          ? String(item.recipientUserId) === String(userId)
          : item.agencyId
            && agencies.some((agency) => String(agency._id) === String(item.agencyId)))
        : announcements,
      refreshJobs: isConsultant ? [] : refreshJobs,
      mailJobs: isConsultant ? [] : mailJobs,
      userId,
      period,
      now,
    });
    pushMonthlyReminderOnce(userId, period, feed.counts.reminders)
      .catch((error) => console.error('[Push] No se pudo enviar el recordatorio mensual:', error.message));
    const readIds = new Set(req.user.readNotificationIds || []);
    const hiddenIds = new Set(req.user.quickViewHiddenNotifications || []);
    const items = feed.items.map((item) => (
      item.category === 'reminder' && readIds.has(item.id)
        ? { ...item, read: true }
        : item
    ));
    const unreadCount = items.filter((item) => (
      ['reminder', 'personal'].includes(item.category) && !item.read
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
        $or: [
          { audience: { $in: ['all', ...(['admin', 'developer'].includes(req.user.rol) ? ['admin'] : [])] } },
          { audience: 'personal', recipientUserId: req.user._id },
        ],
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
      {
        readBy: { $ne: req.user._id },
        $or: [
          { audience: isAdmin ? { $in: ['all', 'admin'] } : 'all' },
          { audience: 'personal', recipientUserId: req.user._id },
        ],
      },
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
    let push = { total: 0, sent: 0 };
    try {
      push = await sendPushToAudience(notification.audience, {
        title: notification.title,
        body: notification.message,
        url: '/notificaciones',
        tag: `announcement-${notification._id}`,
      });
    } catch (error) {
      console.error('[Push] No se pudo distribuir el aviso global:', error.message);
    }
    return res.status(201).json({
      id: String(notification._id),
      title: notification.title,
      message: notification.message,
      severity: notification.severity,
      audience: notification.audience,
      createdAt: notification.createdAt,
      push,
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
