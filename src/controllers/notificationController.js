'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyRefreshJob = require('../models/AgencyRefreshJob');
const MailJob = require('../models/MailJob');
const Notification = require('../models/Notification');
const {
  buildNotificationFeed,
  getMexicoPeriod,
} = require('../utils/notificationUtils');

const ACTIVE_STATUSES = ['queued', 'processing'];
const RECENT_COMPLETION_DAYS = 7;

async function getNotifications(req, res, next) {
  try {
    const userId = req.user._id;
    const isAdmin = ['admin', 'developer'].includes(req.user.rol);
    const now = new Date();
    const period = getMexicoPeriod(now);
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

    return res.json({
      ...buildNotificationFeed({
        agencies,
        announcements,
        refreshJobs,
        mailJobs,
        userId,
        period,
      }),
      period: { ...period, label: `${String(period.month).padStart(2, '0')}/${period.year}` },
    });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'No se encontró la notificación.' });
    }
    const notification = await Notification.findOneAndUpdate(
      {
        _id: req.params.id,
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
  markAllNotificationsRead,
  markNotificationRead,
  publishGlobalNotification,
};
