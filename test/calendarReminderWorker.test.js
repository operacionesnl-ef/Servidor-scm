'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const CalendarEvent = require('../src/models/CalendarEvent');
const pushNotificationService = require('../src/services/pushNotificationService');
const { dispatchCalendarReminders } = require('../src/services/calendarReminderWorker');

function listQuery(events) {
  return {
    select() { return this; },
    lean: async () => events,
  };
}

function dueEvent(now) {
  return {
    _id: new mongoose.Types.ObjectId(),
    title: 'Revisar documentos',
    consultantId: new mongoose.Types.ObjectId(),
    startAt: new Date(now.getTime() + 10 * 60 * 1000),
    reminders: { enabled: true, minutesBefore: [15] },
  };
}

test('calendar reminder worker claims and dispatches an assigned reminder only once', async () => {
  const originalFind = CalendarEvent.find;
  const originalUpdateOne = CalendarEvent.updateOne;
  const originalSendPushToUser = pushNotificationService.sendPushToUser;
  const now = new Date('2026-10-14T16:00:00Z');
  const event = dueEvent(now);
  const claimedKeys = new Set();
  let sends = 0;

  CalendarEvent.find = () => listQuery([event]);
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
  } finally {
    CalendarEvent.find = originalFind;
    CalendarEvent.updateOne = originalUpdateOne;
    pushNotificationService.sendPushToUser = originalSendPushToUser;
  }
});

test('calendar reminder worker releases the claim when no push device receives delivery', async () => {
  const originalFind = CalendarEvent.find;
  const originalUpdateOne = CalendarEvent.updateOne;
  const originalSendPushToUser = pushNotificationService.sendPushToUser;
  const now = new Date('2026-10-14T16:00:00Z');
  const event = dueEvent(now);
  const claimedKeys = new Set();
  let sends = 0;

  CalendarEvent.find = () => listQuery([event]);
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
  pushNotificationService.sendPushToUser = async () => {
    sends += 1;
    return { total: 0, sent: 0 };
  };

  try {
    const first = await dispatchCalendarReminders(now);
    const second = await dispatchCalendarReminders(now);
    assert.equal(first.dispatched, 0);
    assert.equal(second.dispatched, 0);
    assert.equal(sends, 2);
    assert.equal(claimedKeys.size, 0);
  } finally {
    CalendarEvent.find = originalFind;
    CalendarEvent.updateOne = originalUpdateOne;
    pushNotificationService.sendPushToUser = originalSendPushToUser;
  }
});
