'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const CalendarEvent = require('../src/models/CalendarEvent');
const AgencyMonthlyInspection = require('../src/models/AgencyMonthlyInspection');
const Notification = require('../src/models/Notification');
const pushNotificationService = require('../src/services/pushNotificationService');
const { dispatchCalendarReminders } = require('../src/services/calendarReminderWorker');

function listQuery(events) {
  return {
    populate() { return this; },
    select() { return this; },
    lean: async () => events,
  };
}

function dueEvent(now) {
  const consultantId = new mongoose.Types.ObjectId();
  return {
    _id: new mongoose.Types.ObjectId(),
    title: 'Revisar documentos',
    type: 'agency_visit',
    agencyId: {
      _id: new mongoose.Types.ObjectId(),
      nombre: 'Agencia Norte',
      consultantId,
    },
    consultantId,
    startAt: new Date(now.getTime() + 10 * 60 * 1000),
    reminders: { enabled: true, minutesBefore: [15] },
  };
}

test('calendar reminder worker claims and dispatches an assigned reminder only once', async () => {
  const originalFind = CalendarEvent.find;
  const originalUpdateOne = CalendarEvent.updateOne;
  const originalInspectionFind = AgencyMonthlyInspection.find;
  const originalSendPushToUser = pushNotificationService.sendPushToUser;
  const originalNotificationFindOneAndUpdate = Notification.findOneAndUpdate;
  const now = new Date('2026-10-14T16:00:00Z');
  const event = dueEvent(now);
  const claimedKeys = new Set();
  let sends = 0;
  let persistedNotification;

  CalendarEvent.find = () => listQuery([event]);
  AgencyMonthlyInspection.find = () => listQuery([]);
  CalendarEvent.updateOne = async (filter, update) => {
    if (update.$addToSet) {
      const key = update.$addToSet.reminderDispatchKeys;
      if (claimedKeys.has(key)) return { modifiedCount: 0 };
      claimedKeys.add(key);
      return { modifiedCount: 1 };
    }
    claimedKeys.delete(update.$pull.reminderDispatchKeys);
    return { modifiedCount: 1 };
  };
  Notification.findOneAndUpdate = async (_filter, update) => {
    persistedNotification = update.$setOnInsert;
    return { _id: new mongoose.Types.ObjectId(), ...persistedNotification };
  };
  pushNotificationService.sendPushToUser = async () => {
    sends += 1;
    return { total: 1, sent: 1 };
  };

  try {
    const first = await dispatchCalendarReminders(now);
    const second = await dispatchCalendarReminders(now);
    assert.equal(first.dispatched, 1);
    assert.equal(second.dispatched, 0);
    assert.equal(sends, 1);
    assert.equal(claimedKeys.size, 1);
    assert.equal(persistedNotification.audience, 'personal');
    assert.equal(persistedNotification.notificationType, 'visit_reminder');
    assert.match(persistedNotification.message, /Agencia Norte/);
    assert.match(persistedNotification.message, /visita hoy en 10 minutos/);
    assert.match(persistedNotification.actionUrl, /tab=inspections/);
  } finally {
    CalendarEvent.find = originalFind;
    CalendarEvent.updateOne = originalUpdateOne;
    AgencyMonthlyInspection.find = originalInspectionFind;
    pushNotificationService.sendPushToUser = originalSendPushToUser;
    Notification.findOneAndUpdate = originalNotificationFindOneAndUpdate;
  }
});

test('calendar reminder worker retains an in-app reminder when no push device receives delivery', async () => {
  const originalFind = CalendarEvent.find;
  const originalUpdateOne = CalendarEvent.updateOne;
  const originalInspectionFind = AgencyMonthlyInspection.find;
  const originalSendPushToUser = pushNotificationService.sendPushToUser;
  const originalNotificationFindOneAndUpdate = Notification.findOneAndUpdate;
  const now = new Date('2026-10-14T16:00:00Z');
  const event = dueEvent(now);
  const claimedKeys = new Set();
  let sends = 0;

  CalendarEvent.find = () => listQuery([event]);
  AgencyMonthlyInspection.find = () => listQuery([]);
  CalendarEvent.updateOne = async (filter, update) => {
    if (update.$addToSet) {
      const key = update.$addToSet.reminderDispatchKeys;
      if (claimedKeys.has(key)) return { modifiedCount: 0 };
      claimedKeys.add(key);
      return { modifiedCount: 1 };
    }
    claimedKeys.delete(update.$pull.reminderDispatchKeys);
    return { modifiedCount: 1 };
  };
  Notification.findOneAndUpdate = async (_filter, update) => ({
    _id: new mongoose.Types.ObjectId(),
    ...update.$setOnInsert,
  });
  pushNotificationService.sendPushToUser = async () => {
    sends += 1;
    return { total: 0, sent: 0 };
  };

  try {
    const first = await dispatchCalendarReminders(now);
    const second = await dispatchCalendarReminders(now);
    assert.equal(first.dispatched, 1);
    assert.equal(second.dispatched, 0);
    assert.equal(sends, 1);
    assert.equal(claimedKeys.size, 1);
  } finally {
    CalendarEvent.find = originalFind;
    CalendarEvent.updateOne = originalUpdateOne;
    AgencyMonthlyInspection.find = originalInspectionFind;
    pushNotificationService.sendPushToUser = originalSendPushToUser;
    Notification.findOneAndUpdate = originalNotificationFindOneAndUpdate;
  }
});

test('calendar reminder worker sends an auxiliary-specific confirmation reminder to both assignments', async () => {
  const originalFind = CalendarEvent.find;
  const originalUpdateOne = CalendarEvent.updateOne;
  const originalInspectionFind = AgencyMonthlyInspection.find;
  const originalSendPushToUser = pushNotificationService.sendPushToUser;
  const originalNotificationFindOneAndUpdate = Notification.findOneAndUpdate;
  const now = new Date('2026-10-14T16:00:00Z');
  const event = dueEvent(now);
  const auxiliaryId = new mongoose.Types.ObjectId();
  event.agencyId.auxiliaryConsultantId = auxiliaryId;
  const claimedKeys = new Set();
  const notifications = [];
  const pushes = [];

  CalendarEvent.find = () => listQuery([event]);
  AgencyMonthlyInspection.find = () => listQuery([{
    calendarEventId: event._id,
    attendanceStatus: 'pending',
  }]);
  CalendarEvent.updateOne = async (_filter, update) => {
    if (update.$addToSet) {
      const key = update.$addToSet.reminderDispatchKeys;
      if (claimedKeys.has(key)) return { modifiedCount: 0 };
      claimedKeys.add(key);
      return { modifiedCount: 1 };
    }
    claimedKeys.delete(update.$pull.reminderDispatchKeys);
    return { modifiedCount: 1 };
  };
  Notification.findOneAndUpdate = async (_filter, update) => {
    notifications.push(update.$setOnInsert);
    return { _id: new mongoose.Types.ObjectId(), ...update.$setOnInsert };
  };
  pushNotificationService.sendPushToUser = async (userId) => {
    pushes.push(String(userId));
    return { total: 1, sent: 1 };
  };

  try {
    const result = await dispatchCalendarReminders(now);
    const auxiliaryNotice = notifications.find((notice) => (
      String(notice.recipientUserId) === String(auxiliaryId)
    ));
    assert.equal(result.dispatched, 2);
    assert.deepEqual(new Set(pushes), new Set([
      String(event.consultantId),
      String(auxiliaryId),
    ]));
    assert.match(auxiliaryNotice.title, /Confirmación pendiente/);
    assert.match(auxiliaryNotice.message, /confirma.*asistirás tú o el consultor principal/i);
    assert.notEqual(notifications[0].idempotencyKey, notifications[1].idempotencyKey);
  } finally {
    CalendarEvent.find = originalFind;
    CalendarEvent.updateOne = originalUpdateOne;
    AgencyMonthlyInspection.find = originalInspectionFind;
    pushNotificationService.sendPushToUser = originalSendPushToUser;
    Notification.findOneAndUpdate = originalNotificationFindOneAndUpdate;
  }
});
