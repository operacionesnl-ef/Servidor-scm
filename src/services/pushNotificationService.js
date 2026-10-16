'use strict';

const webpush = require('web-push');
const Subscription = require('../models/Subscription');
const User = require('../models/User');

async function deliverPush(subscriptions, notification) {
  if (!subscriptions.length) return { total: 0, sent: 0 };

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url || '/notificaciones',
    ...(notification.tag ? { tag: notification.tag } : {}),
  });

  const results = await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: subscription.keys,
      }, payload);
      return true;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await Subscription.deleteOne({ _id: subscription._id });
      } else {
        console.error('[Push] Error enviando notificación:', subscription._id, error.statusCode, error.body || error.message);
      }
      return false;
    }
  }));

  return { total: subscriptions.length, sent: results.filter(Boolean).length };
}

async function sendPushToUser(userId, notification) {
  if (!userId) return { total: 0, sent: 0 };
  const subscriptions = await Subscription.find({ userId }).lean();
  return deliverPush(subscriptions, notification);
}

async function sendPushToAudience(audience, notification) {
  const userFilter = { status: 'activo' };
  if (audience === 'admin') userFilter.rol = { $in: ['admin', 'developer'] };

  const users = await User.find(userFilter).select('_id').lean();
  if (!users.length) return { total: 0, sent: 0 };

  const subscriptions = await Subscription.find({
    userId: { $in: users.map((user) => user._id) },
  }).lean();
  return deliverPush(subscriptions, notification);
}

module.exports = { sendPushToAudience, sendPushToUser };