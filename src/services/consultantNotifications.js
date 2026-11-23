'use strict';

const Notification = require('../models/Notification');
const Subscription = require('../models/Subscription');
const { publishNotificationChange } = require('./notificationEvents');
const { sendPushToUser } = require('./pushNotificationService');
const { getAgencyConsultants } = require('../utils/agencyConsultants');

async function createConsultantNotification({
  consultantId,
  title,
  message,
  notificationType,
  actionUrl,
  agencyId,
  idempotencyKey,
}) {
  if (!consultantId || !title || !message || !notificationType || !idempotencyKey) return null;
  let notification;
  try {
    notification = await Notification.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          title,
          message,
          severity: notificationType.includes('cancelled') ? 'high' : 'medium',
          audience: 'personal',
          recipientUserId: consultantId,
          notificationType,
          actionUrl: actionUrl || '/notificaciones',
          ...(agencyId ? { agencyId } : {}),
          idempotencyKey,
          createdBy: consultantId,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    publishNotificationChange();
  } catch (error) {
    if (error.code === 11000) {
      try {
        notification = await Notification.findOne({ idempotencyKey });
      } catch (lookupError) {
        console.error('[Notifications] No se pudo recuperar un aviso ya registrado:', lookupError.message);
        return null;
      }
    } else {
      console.error('[Notifications] No se pudo guardar un aviso personal:', error.message);
      return null;
    }
  }

  return notification || null;
}

async function notifyConsultant(payload) {
  const notification = await createConsultantNotification(payload);
  if (!notification) return null;
  try {
    const hasSubscription = await Subscription.exists({ userId: payload.consultantId });
    if (hasSubscription) {
      const result = await sendPushToUser(payload.consultantId, {
        title: notification.title,
        body: notification.message,
        url: notification.actionUrl,
        tag: `consultant-${notification._id}`,
      });
      if (result.sent) return notification;
    }
  } catch (error) {
    console.error('[Push] El aviso quedó guardado, pero no se pudo entregar por Web Push:', error.message);
  }
  return notification;
}

async function notifyAgencyConsultants(agency, payload) {
  const recipients = getAgencyConsultants(agency);
  return Promise.all(recipients.map(({ id, role }) => {
    const isAuxiliary = role === 'auxiliary';
    return notifyConsultant({
      ...payload,
      consultantId: id,
      title: isAuxiliary ? payload.auxiliaryTitle || `${payload.title} · Auxiliar` : payload.title,
      message: isAuxiliary ? payload.auxiliaryMessage || payload.message : payload.message,
      notificationType: isAuxiliary
        ? payload.auxiliaryNotificationType || `${payload.notificationType}_auxiliary`
        : payload.notificationType,
      idempotencyKey: `${payload.idempotencyKey}:${role}:${id}`,
    });
  }));
}

module.exports = {
  createConsultantNotification,
  notifyAgencyConsultants,
  notifyConsultant,
};
