'use strict';

const Agency = require('../models/Agency');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const User = require('../models/User');
const pushNotificationService = require('./pushNotificationService');
const { getMexicoPeriod } = require('../utils/notificationUtils');

const REMINDER_CLAIM_TTL_MS = 5 * 60 * 1000;

function getCurrentPeriod(now) {
  const { year, month } = getMexicoPeriod(now);
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function sendPendingInspectionReminder(agency, period, now) {
  const record = await AgencyMonthlyInspection.findOneAndUpdate(
    {
      agencyId: agency._id,
      period,
      visitStatus: { $ne: 'completed' },
      reminderSentAt: null,
      $or: [
        { reminderClaimedAt: null },
        { reminderClaimedAt: { $lt: new Date(now.getTime() - REMINDER_CLAIM_TTL_MS) } },
      ],
    },
    { $set: { reminderClaimedAt: now } },
    { new: true },
  );
  if (!record) return false;

  try {
    if (!await User.exists({ _id: agency.consultantId, rol: 'consultor', status: 'activo' })) {
      await AgencyMonthlyInspection.updateOne(
        { _id: record._id, reminderSentAt: null },
        { $set: { reminderClaimedAt: null } },
      );
      return false;
    }
    const result = await pushNotificationService.sendPushToUser(agency.consultantId, {
      title: 'Inspección mensual pendiente',
      body: `La inspección de ${agency.nombre} para ${period} sigue pendiente.`,
      url: '/agencias',
      tag: `agency-inspection-${String(agency._id)}-${period}`,
    });
    if (!result.sent) {
      await AgencyMonthlyInspection.updateOne(
        { _id: record._id, reminderSentAt: null },
        { $set: { reminderClaimedAt: null } },
      );
      return false;
    }
    await AgencyMonthlyInspection.updateOne(
      { _id: record._id, reminderClaimedAt: now },
      { $set: { reminderSentAt: new Date() }, $unset: { reminderClaimedAt: 1 } },
    );
    return true;
  } catch (error) {
    await AgencyMonthlyInspection.updateOne(
      { _id: record._id, reminderSentAt: null },
      { $set: { reminderClaimedAt: null } },
    );
    throw error;
  }
}

async function dispatchMonthlyInspectionReminders(now = new Date()) {
  const { month } = getMexicoPeriod(now);
  const period = getCurrentPeriod(now);
  const agencies = await Agency.find({
    status: 'activa',
    consultantId: { $ne: null },
  }).select('_id nombre consultantId').lean();

  let dispatched = 0;
  for (const agency of agencies) {
    await AgencyMonthlyInspection.updateOne(
      { agencyId: agency._id, period },
      { $setOnInsert: { authorizationStatus: 'pending', visitStatus: 'scheduled' } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    if (await sendPendingInspectionReminder(agency, period, now)) dispatched += 1;
  }
  return { agencies: agencies.length, dispatched, period };
}

module.exports = { dispatchMonthlyInspectionReminders };
