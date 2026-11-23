'use strict';

const Agency = require('../models/Agency');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const User = require('../models/User');
const pushNotificationService = require('./pushNotificationService');
const { getMexicoPeriod } = require('../utils/notificationUtils');
const { getAgencyConsultants } = require('../utils/agencyConsultants');

const REMINDER_CLAIM_TTL_MS = 5 * 60 * 1000;

function getCurrentPeriod(now) {
  const { year, month } = getMexicoPeriod(now);
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function sendPendingInspectionReminder(agency, period, now) {
  const recordQuery = AgencyMonthlyInspection.findOneAndUpdate(
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
  ).select('+reminderSentTo');
  const record = await recordQuery;
  if (!record) return false;

  try {
    const sentTo = new Set((record.reminderSentTo || []).map(String));
    let deliveryPending = false;
    for (const recipient of getAgencyConsultants(agency)) {
      if (sentTo.has(recipient.id)) continue;
      const activeConsultant = await User.exists({
        _id: recipient.id,
        rol: 'consultor',
        status: 'activo',
      });
      if (!activeConsultant) {
        await AgencyMonthlyInspection.updateOne(
          { _id: record._id },
          { $addToSet: { reminderSentTo: recipient.id } },
        );
        sentTo.add(recipient.id);
        continue;
      }
      const isAuxiliary = recipient.role === 'auxiliary';
      const result = await pushNotificationService.sendPushToUser(recipient.id, {
        title: isAuxiliary
          ? 'Inspección mensual pendiente · Auxiliar'
          : 'Inspección mensual pendiente',
        body: isAuxiliary
          ? `La inspección de ${agency.nombre} para ${period} sigue pendiente. Revisa la visita en Inspecciones y confirma quién asistirá cuando esté programada.`
          : `La inspección de ${agency.nombre} para ${period} sigue pendiente.`,
        url: `/agencias/${agency._id}?tab=inspections`,
        tag: `agency-inspection-${String(agency._id)}-${period}-${recipient.id}`,
      });
      if (result.sent) {
        await AgencyMonthlyInspection.updateOne(
          { _id: record._id },
          { $addToSet: { reminderSentTo: recipient.id } },
        );
        sentTo.add(recipient.id);
      } else {
        deliveryPending = true;
      }
    }
    if (deliveryPending) {
      await AgencyMonthlyInspection.updateOne(
        { _id: record._id, reminderSentAt: null },
        { $set: { reminderClaimedAt: null } },
      );
      return false;
    }
    await AgencyMonthlyInspection.updateOne(
      { _id: record._id, reminderClaimedAt: now },
      {
        $set: { reminderSentAt: new Date() },
        $unset: { reminderClaimedAt: 1 },
      },
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
  }).select('_id nombre consultantId auxiliaryConsultantId').lean();

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
