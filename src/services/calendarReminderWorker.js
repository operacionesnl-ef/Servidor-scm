'use strict';

const CalendarEvent = require('../models/CalendarEvent');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const pushNotificationService = require('./pushNotificationService');
const { createConsultantNotification } = require('./consultantNotifications');
const { getAgencyConsultants } = require('../utils/agencyConsultants');
const { dispatchMonthlyInspectionReminders } = require('./agencyMonthlyInspectionReminders');
const { logEvent } = require('../utils/consoleLogger');

const CALENDAR_REMINDER_POLL_MS = 60 * 1000;
const MAX_REMINDER_MINUTES = 525600;
let workerPromise = null;
let pollTimer = null;

function getDispatchKey(event, userId, minutesBefore) {
  return `${event.startAt.getTime()}:${userId}:${minutesBefore}`;
}

function formatTimeUntilVisit(startAt, now) {
  const minutes = Math.max(1, Math.ceil((startAt.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const hourLabel = `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  return remainingMinutes
    ? `${hourLabel} y ${remainingMinutes} ${remainingMinutes === 1 ? 'minuto' : 'minutos'}`
    : hourLabel;
}

async function dispatchOneReminder(event, recipient, minutesBefore, now, attendanceStatus) {
  const userId = recipient.id;
  const isAuxiliary = recipient.role === 'auxiliary';
  const dispatchKey = getDispatchKey(event, userId, minutesBefore);
  const claimed = await CalendarEvent.updateOne(
    {
      _id: event._id,
      authorized: true,
      consultantId: event.consultantId,
      startAt: event.startAt,
      'reminders.enabled': true,
      'reminders.minutesBefore': minutesBefore,
      reminderDispatchKeys: { $ne: dispatchKey },
    },
    { $addToSet: { reminderDispatchKeys: dispatchKey } },
  );
  if (!claimed.modifiedCount) return false;

  try {
    const agency = event.agencyId && typeof event.agencyId === 'object' ? event.agencyId : null;
    const agencyName = agency?.nombre || event.title || 'tu evento';
    const visitDate = event.startAt.toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Mexico_City',
    });
    const isVisitToday = event.startAt.toLocaleDateString('es-MX', {
      timeZone: 'America/Mexico_City',
    }) === now.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });
    const visitMessage = event.type === 'agency_visit'
        ? isVisitToday
          ? `Tienes que ir a ${agencyName}; tienes una visita hoy en ${formatTimeUntilVisit(event.startAt, now)}.`
          : `Tienes que ir a ${agencyName}; tu visita está programada para el ${visitDate} (en ${formatTimeUntilVisit(event.startAt, now)}).`
        : `${agencyName} está programado para el ${visitDate}.`;
    const auxiliaryMessage = attendanceStatus === 'pending'
      ? `${agencyName} tiene una visita programada para el ${visitDate}. Confirma en Inspecciones si asistirás tú o el consultor principal.`
      : attendanceStatus
        ? `${agencyName} tiene una visita programada para el ${visitDate}. La asistencia ya fue confirmada.`
        : visitMessage;
    const notification = await createConsultantNotification({
      consultantId: userId,
      title: isAuxiliary
        ? attendanceStatus === 'pending'
          ? `Confirmación pendiente: ${agencyName}`
          : `Recordatorio de visita · Auxiliar: ${agencyName}`
        : `Recordatorio: ${agencyName}`,
      message: isAuxiliary ? auxiliaryMessage : visitMessage,
      notificationType: isAuxiliary
        ? attendanceStatus === 'pending' ? 'visit_attendance_confirmation' : 'visit_reminder_auxiliary'
        : event.type === 'agency_visit' ? 'visit_reminder' : 'calendar_reminder',
      actionUrl: agency
        ? `/agencias/${agency._id}?tab=inspections`
        : '/calendario',
      agencyId: agency?._id || null,
      idempotencyKey: `calendar-reminder:${event._id}:${minutesBefore}:${event.startAt.getTime()}:${userId}`,
    });
    if (!notification) {
      await CalendarEvent.updateOne(
        { _id: event._id },
        { $pull: { reminderDispatchKeys: dispatchKey } },
      );
      return false;
    }
    const result = await pushNotificationService.sendPushToUser(userId, {
      title: notification.title,
      body: notification.message,
      url: notification.actionUrl,
      tag: `calendar-reminder-${String(event._id)}-${minutesBefore}-${event.startAt.getTime()}-${userId}`,
    });
    if (!result.sent && result.total > 0) {
      logEvent('calendar_reminder_web_push_not_delivered', {
        eventId: String(event._id),
        consultantId: userId,
        subscriptions: result.total,
      });
    }
    return true;
  } catch (error) {
    await CalendarEvent.updateOne(
      { _id: event._id },
      { $pull: { reminderDispatchKeys: dispatchKey } },
    );
    throw error;
  }
}

async function dispatchCalendarReminders(now = new Date()) {
  const latestStartAt = new Date(now.getTime() + MAX_REMINDER_MINUTES * 60 * 1000);
  const events = await CalendarEvent.find({
    authorized: true,
    consultantId: { $ne: null },
    'reminders.enabled': true,
    startAt: { $gt: now, $lte: latestStartAt },
  })
    .populate('agencyId', 'nombre consultantId auxiliaryConsultantId')
    .select('_id title type startAt consultantId reminders agencyId')
    .lean();

  const agencyVisitIds = events
    .filter((event) => event.type === 'agency_visit')
    .map((event) => event._id);
  const inspectionRecords = agencyVisitIds.length
    ? await AgencyMonthlyInspection.find({ calendarEventId: { $in: agencyVisitIds } })
      .select('calendarEventId attendanceStatus')
      .lean()
    : [];
  const attendanceByEventId = new Map(inspectionRecords.map((record) => [
    String(record.calendarEventId),
    record.attendanceStatus,
  ]));
  let dispatched = 0;
  for (const event of events) {
    const recipients = event.type === 'agency_visit'
      ? getAgencyConsultants(event.agencyId)
      : event.consultantId ? [{ id: String(event.consultantId), role: 'principal' }] : [];
    if (!recipients.length) continue;
    for (const minutesBefore of event.reminders?.minutesBefore || []) {
      const dueAt = new Date(event.startAt.getTime() - minutesBefore * 60 * 1000);
      if (dueAt > now) continue;
      for (const recipient of recipients) {
        if (await dispatchOneReminder(
          event,
          recipient,
          minutesBefore,
          now,
          attendanceByEventId.get(String(event._id)),
        )) dispatched += 1;
      }
    }
  }
  return { events: events.length, dispatched };
}

function runCalendarReminderWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = Promise.all([
    dispatchCalendarReminders(),
    dispatchMonthlyInspectionReminders(),
  ])
    .catch((error) => {
      logEvent('calendar_reminder_worker_failed', { message: error.message });
    })
    .finally(() => { workerPromise = null; });
  return workerPromise;
}

function startCalendarReminderWorker() {
  if (pollTimer) return pollTimer;
  void runCalendarReminderWorker();
  pollTimer = setInterval(runCalendarReminderWorker, CALENDAR_REMINDER_POLL_MS);
  pollTimer.unref?.();
  return pollTimer;
}

module.exports = {
  CALENDAR_REMINDER_POLL_MS,
  dispatchCalendarReminders,
  startCalendarReminderWorker,
};
