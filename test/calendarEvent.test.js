'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const CalendarEvent = require('../src/models/CalendarEvent');
const CalendarEventModel = require('../src/models/CalendarEvent');
const {
  getCalendarEvents,
  validateEventInput,
} = require('../src/controllers/calendarController');
const requireAdminOrDeveloper = require('../src/middlewares/requireAdminOrDeveloper');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('calendar event schema enforces required fields, type and increasing date range', () => {
  const now = new Date('2026-10-14T15:00:00.000Z');
  const event = new CalendarEvent({
    title: 'Visita',
    type: 'agency_visit',
    startAt: now,
    endAt: now,
    createdBy: new mongoose.Types.ObjectId(),
    updatedBy: new mongoose.Types.ObjectId(),
  });
  const errors = event.validateSync().errors;
  assert.ok(errors.endAt);
  assert.equal(errors.title, undefined);

  event.type = 'unknown';
  assert.ok(event.validateSync().errors.type);
});

test('calendar input validation accepts the API contract and rejects malformed ranges', () => {
  const valid = validateEventInput({
    title: 'Revisar expediente',
    type: 'file_review',
    startAt: '2026-10-14T10:00:00-06:00',
    endAt: '2026-10-14T11:00:00-06:00',
    agencyId: null,
    consultantId: null,
    status: 'pending',
    reminders: { enabled: true, minutesBefore: [30, 10] },
  }, false);
  assert.deepEqual(valid.errors, {});
  assert.equal(valid.value.authorized, false);
  assert.ok(valid.value.startAt instanceof Date);

  const invalid = validateEventInput({
    title: 'Bad time',
    type: 'agency_visit',
    startAt: 'not-a-date',
    endAt: '2026-10-14T10:00:00Z',
  }, false);
  assert.ok(invalid.errors.startAt);
});

test('calendar listing overlaps date ranges, scopes non-admins to authorized events and supports mine', async () => {
  const originalFind = CalendarEventModel.find;
  const userId = new mongoose.Types.ObjectId();
  let filter;
  CalendarEventModel.find = (query) => {
    filter = query;
    return {
      populate() { return this; },
      sort() { return this; },
      lean: async () => [],
    };
  };
  try {
    const res = response();
    await getCalendarEvents({
      user: { _id: userId, rol: 'consultor' },
      query: {
        rangeStart: '2026-10-14T00:00:00Z',
        rangeEnd: '2026-10-15T00:00:00Z',
        view: 'mine',
      },
    }, res, (error) => { throw error; });
    assert.equal(filter.authorized, true);
    assert.deepEqual(filter.consultantId, userId);
    assert.equal(filter.startAt.$lt.toISOString(), '2026-10-15T00:00:00.000Z');
    assert.equal(filter.endAt.$gt.toISOString(), '2026-10-14T00:00:00.000Z');
    assert.deepEqual(res.body.data.events, []);
  } finally {
    CalendarEventModel.find = originalFind;
  }
});

test('calendar list does not reveal unauthorized events to ordinary users', async () => {
  const originalFind = CalendarEventModel.find;
  let filter;
  CalendarEventModel.find = (query) => {
    filter = query;
    return { populate() { return this; }, sort() { return this; }, lean: async () => [] };
  };
  try {
    const res = response();
    await getCalendarEvents({
      user: { _id: new mongoose.Types.ObjectId(), rol: 'user' },
      query: { rangeStart: '2026-10-14T00:00:00Z', rangeEnd: '2026-10-15T00:00:00Z' },
    }, res, (error) => { throw error; });
    assert.equal(filter.authorized, true);
  } finally {
    CalendarEventModel.find = originalFind;
  }
});

test('calendar write middleware permits only admin and developer roles', () => {
  for (const role of ['admin', 'developer']) {
    let continued = false;
    requireAdminOrDeveloper({ user: { rol: role } }, response(), () => { continued = true; });
    assert.equal(continued, true);
  }
  for (const role of ['consultor', 'user']) {
    const res = response();
    requireAdminOrDeveloper({ user: { rol: role } }, res, () => {});
    assert.equal(res.statusCode, 403);
  }
});
