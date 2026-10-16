'use strict';

const CalendarEvent = require('../models/CalendarEvent');
const pushNotificationService = require('./pushNotificationService');
const { dispatchMonthlyInspectionReminders } = require('./agencyMonthlyInspectionReminders');
const { logEvent } = require('../utils/consoleLogger');

const CALENDAR_REMINDER_POLL_MS = 60 * 1000;
const MAX_REMINDER_MINUTES = 525600;
let workerPromise = null;
let pollTimer = null;

function getDispatchKey(event, userId, minutesBefore) {
  return `${event.startAt.getTime()}:${userId}:${minutesBefore}`;
}

async function dispatchOneReminder(event, minutesBefore) {
  const userId = String(event.consultantId);
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
    const result = await pushNotificationService.sendPushToUser(event.consultantId, {
      title: `Recordatorio: ${event.title}`,
      body: 'Tienes un evento próximo en el calendario operacional.',
      url: '/notificaciones',
      tag: `calendar-reminder-${String(event._id)}-${minutesBefore}-${event.startAt.getTime()}`,
    });
    if (!result.sent) {
      await CalendarEvent.updateOne(
        { _id: event._id },
        { $pull: { reminderDispatchKeys: dispatchKey } },
      );
      return false;
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
    .select('_id title startAt consultantId reminders')
    .lean();

  let dispatched = 0;
  for (const event of events) {
    for (const minutesBefore of event.reminders?.minutesBefore || []) {
      const dueAt = new Date(event.startAt.getTime() - minutesBefore * 60 * 1000);
      if (dueAt <= now && await dispatchOneReminder(event, minutesBefore)) dispatched += 1;
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
