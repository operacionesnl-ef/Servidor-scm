'use strict';

const Agency = require('../models/Agency');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const pushNotificationService = require('./pushNotificationService');
const { getAgencyConsultants } = require('../utils/agencyConsultants');
const { getMexicoPeriod, getMissingCurrentReportCodes } = require('../utils/notificationUtils');

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const RECIPIENT_ROLES = ['admin', 'developer', 'consultor'];
let lastCheckedPeriod = '';
let lastCheckedAt = 0;
let dispatchPromise = null;

function getPeriodKey(now) {
  const { year, month } = getMexicoPeriod(now);
  return {
    year,
    month,
    key: `${year}-${String(month).padStart(2, '0')}`,
  };
}

async function dispatchForPeriod(now, period) {
  const [agencies, monthlyRecords, users] = await Promise.all([
    Agency.find({ status: 'activa' })
      .select('_id nombre consultantId auxiliaryConsultantId status archivos reviewPeriods')
      .lean(),
    AgencyMonthlyFiles.find({ period: period.key })
      .select('agencyId archivos')
      .lean(),
    User.find({ status: 'activo', rol: { $in: RECIPIENT_ROLES } })
      .select('_id rol lastPushReminderPeriod')
      .lean(),
  ]);
  const filesByAgency = new Map(monthlyRecords.map((record) => [
    String(record.agencyId),
    record.archivos || {},
  ]));
  const missingCountsByConsultant = new Map();
  let globalMissingCount = 0;

  for (const agency of agencies) {
    const agencyWithPeriodFiles = {
      ...agency,
      archivos: filesByAgency.get(String(agency._id)) || {},
    };
    if (!getMissingCurrentReportCodes(agencyWithPeriodFiles, period.year, period.month).length) continue;

    globalMissingCount += 1;
    for (const consultant of getAgencyConsultants(agency)) {
      missingCountsByConsultant.set(
        consultant.id,
        (missingCountsByConsultant.get(consultant.id) || 0) + 1,
      );
    }
  }

  let sent = 0;
  for (const user of users) {
    const userId = user._id;
    const count = user.rol === 'consultor'
      ? missingCountsByConsultant.get(String(userId)) || 0
      : globalMissingCount;
    if (!count || user.lastPushReminderPeriod === period.key) continue;
    if (!await Subscription.exists({ userId })) continue;

    const claimed = await User.findOneAndUpdate(
      { _id: userId, lastPushReminderPeriod: { $ne: period.key } },
      { $set: { lastPushReminderPeriod: period.key } },
      { new: true },
    );
    if (!claimed) continue;

    try {
      const result = await pushNotificationService.sendPushToUser(userId, {
        title: 'Recordatorio de reportes pendientes',
        body: `Hay ${count} agencia${count === 1 ? '' : 's'} con reportes pendientes para ${String(period.month).padStart(2, '0')}/${period.year}.`,
        url: '/notificaciones',
        tag: `agency-reminder-${period.key}`,
      });
      if (result.sent) {
        sent += 1;
      } else {
        await User.updateOne(
          { _id: userId, lastPushReminderPeriod: period.key },
          { $unset: { lastPushReminderPeriod: 1 } },
        );
      }
    } catch (error) {
      await User.updateOne(
        { _id: userId, lastPushReminderPeriod: period.key },
        { $unset: { lastPushReminderPeriod: 1 } },
      );
      throw error;
    }
  }

  return { sent, period: period.key, pendingAgencies: globalMissingCount };
}

function dispatchMonthlyReportReminders(now = new Date()) {
  const period = getPeriodKey(now);
  if (
    lastCheckedPeriod === period.key
    && now.getTime() - lastCheckedAt < CHECK_INTERVAL_MS
  ) {
    return Promise.resolve({ sent: 0, period: period.key, skipped: true });
  }
  if (dispatchPromise) return dispatchPromise;

  dispatchPromise = dispatchForPeriod(now, period)
    .then((result) => {
      lastCheckedPeriod = period.key;
      lastCheckedAt = now.getTime();
      return result;
    })
    .finally(() => { dispatchPromise = null; });
  return dispatchPromise;
}

module.exports = {
  CHECK_INTERVAL_MS,
  dispatchMonthlyReportReminders,
};
