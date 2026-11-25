'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const CalendarEvent = require('../src/models/CalendarEvent');
const {
  getLocalParts,
  localDateTimeToUtc,
} = require('../src/services/monthlyRecalendarization');
const {
  hasScheduleConflict,
  validateCalendarSlots,
  validateWorkingSlot,
} = require('../src/services/calendarAvailability');

function localDate(year, month, day, hour, minute = 0) {
  return localDateTimeToUtc({ year, month, day, hour, minute });
}

test('Saturday visits are only accepted from 09:00 through 12:00', () => {
  const tooEarly = validateWorkingSlot({
    startAt: localDate(2026, 11, 7, 8),
    endAt: localDate(2026, 11, 7, 9),
  }, '2026-11');
  const allowed = validateWorkingSlot({
    startAt: localDate(2026, 11, 7, 9),
    endAt: localDate(2026, 11, 7, 12),
  }, '2026-11');
  const tooLate = validateWorkingSlot({
    startAt: localDate(2026, 11, 7, 11),
    endAt: localDate(2026, 11, 7, 12, 1),
  }, '2026-11');

  assert.match(tooEarly.error, /sábados.*entre 09:00 y 12:00/i);
  assert.equal(allowed.error, null);
  assert.match(tooLate.error, /sábados.*entre 09:00 y 12:00/i);
});

test('weekdays end by 17:00 and Sundays or federal holidays are not schedulable', () => {
  const weekdayOverrun = validateWorkingSlot({
    startAt: localDate(2026, 11, 3, 16),
    endAt: localDate(2026, 11, 3, 17, 1),
  });
  const sunday = validateWorkingSlot({
    startAt: localDate(2026, 11, 1, 10),
    endAt: localDate(2026, 11, 1, 11),
  });
  const holiday = validateWorkingSlot({
    startAt: localDate(2026, 11, 16, 10),
    endAt: localDate(2026, 11, 16, 11),
  });

  assert.match(weekdayOverrun.error, /lunes a viernes.*entre 08:00 y 17:00/i);
  assert.match(sunday.error, /domingos/i);
  assert.match(holiday.error, /día festivo/i);
});

test('monthly visit validation rejects dates outside the selected period', () => {
  const result = validateWorkingSlot({
    startAt: localDate(2026, 11, 2, 10),
    endAt: localDate(2026, 11, 2, 11),
  }, '2026-10');
  assert.match(result.error, /dentro del período 2026-10/);
});

test('consultant conflicts enforce the exact 15-minute margin', async () => {
  const originalFind = CalendarEvent.find;
  const consultantId = new mongoose.Types.ObjectId();
  const eventId = new mongoose.Types.ObjectId();
  CalendarEvent.find = (query) => {
    assert.equal(String(query.consultantId), String(consultantId));
    assert.equal(String(query._id.$ne), String(eventId));
    return {
      select() { return this; },
      lean: async () => [{
        _id: new mongoose.Types.ObjectId(),
        title: 'Evento existente',
        startAt: localDate(2026, 11, 2, 9),
        endAt: localDate(2026, 11, 2, 10),
      }],
    };
  };
  try {
    const shortGap = await validateCalendarSlots([{
      startAt: localDate(2026, 11, 2, 10, 14),
      endAt: localDate(2026, 11, 2, 10, 44),
    }], { consultantId, excludeEventId: eventId });
    const exactGap = await validateCalendarSlots([{
      startAt: localDate(2026, 11, 2, 10, 15),
      endAt: localDate(2026, 11, 2, 10, 45),
    }], { consultantId, excludeEventId: eventId });
    assert.ok(shortGap.conflict);
    const suggested = getLocalParts(shortGap.conflict.suggestedStartAt);
    assert.deepEqual([suggested.hour, suggested.minute], [10, 15]);
    assert.equal(exactGap.conflict, null);
  } finally {
    CalendarEvent.find = originalFind;
  }
});

test('a recurrence batch is checked for conflicts between its own visits', async () => {
  const originalFind = CalendarEvent.find;
  CalendarEvent.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  try {
    const result = await validateCalendarSlots([
      { startAt: localDate(2026, 11, 2, 9), endAt: localDate(2026, 11, 2, 10) },
      { startAt: localDate(2026, 11, 2, 10, 14), endAt: localDate(2026, 11, 2, 11, 14) },
    ], { consultantId: new mongoose.Types.ObjectId() });
    assert.ok(result.conflict);
    assert.equal(result.conflict.reservation.title, undefined);
  } finally {
    CalendarEvent.find = originalFind;
  }
});

test('time overlap calculation allows exactly 15 minutes but rejects 14', () => {
  const existing = {
    startAt: localDate(2026, 11, 2, 9),
    endAt: localDate(2026, 11, 2, 10),
  };
  assert.equal(hasScheduleConflict({
    startAt: localDate(2026, 11, 2, 10, 14),
    endAt: localDate(2026, 11, 2, 11, 14),
  }, existing, 15 * 60_000), true);
  assert.equal(hasScheduleConflict({
    startAt: localDate(2026, 11, 2, 10, 15),
    endAt: localDate(2026, 11, 2, 11, 15),
  }, existing, 15 * 60_000), false);
});
