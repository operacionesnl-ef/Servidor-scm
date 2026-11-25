'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const CalendarEvent = require('../src/models/CalendarEvent');
const CalendarEventModel = require('../src/models/CalendarEvent');
const Agency = require('../src/models/Agency');
const {
  createCalendarEvent,
  createCalendarEventSeries,
  getCalendarEvents,
  updateCalendarEvent,
  validateEventSeriesInput,
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

test('calendar API rejects an agency visit scheduled before Saturday opening', async () => {
  const originalCreate = CalendarEvent.create;
  let created = false;
  CalendarEvent.create = async (input) => {
    created = true;
    return input;
  };
  try {
    const res = response();
    await createCalendarEvent({
      user: { _id: new mongoose.Types.ObjectId() },
      body: {
        title: 'Visita sabatina',
        type: 'agency_visit',
        startAt: '2026-10-03T14:00:00-06:00',
        endAt: '2026-10-03T15:00:00-06:00',
        agencyId: null,
        consultantId: null,
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.errors.startAt, /sábados.*entre 09:00 y 12:00/i);
    assert.equal(created, false);
  } finally {
    CalendarEvent.create = originalCreate;
  }
});

test('calendar API rejects moving an existing visit outside working hours', async () => {
  const originalFindById = CalendarEvent.findById;
  const event = {
    _id: new mongoose.Types.ObjectId(),
    title: 'Visita de agencia',
    type: 'agency_visit',
    startAt: new Date('2026-10-05T16:00:00.000Z'),
    endAt: new Date('2026-10-05T17:00:00.000Z'),
    agencyId: null,
    consultantId: new mongoose.Types.ObjectId(),
    authorized: false,
    updatedAt: new Date(),
    saves: 0,
    async save() { this.saves += 1; },
  };
  CalendarEvent.findById = async () => event;
  try {
    const res = response();
    await updateCalendarEvent({
      params: { id: String(event._id) },
      user: { _id: new mongoose.Types.ObjectId() },
      body: {
        startAt: '2026-10-03T14:00:00-06:00',
        endAt: '2026-10-03T15:00:00-06:00',
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.errors.startAt, /sábados.*entre 09:00 y 12:00/i);
    assert.equal(event.saves, 0);
  } finally {
    CalendarEvent.findById = originalFindById;
  }
});

test('calendar series validation requires a bounded recurrence and consistent occurrences', () => {
  const input = {
    event: {
      title: 'Revisar expedientes',
      type: 'file_review',
      startAt: '2026-10-14T10:00:00Z',
      endAt: '2026-10-14T11:00:00Z',
      agencyId: null,
    },
    recurrence: {
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3],
      endDate: '2026-11-30',
    },
    occurrences: [
      { startAt: '2026-10-14T10:00:00Z', endAt: '2026-10-14T11:00:00Z' },
      { startAt: '2026-10-28T10:00:00Z', endAt: '2026-10-28T11:00:00Z' },
    ],
  };
  assert.deepEqual(validateEventSeriesInput(input).errors, {});

  const invalid = validateEventSeriesInput({
    ...input,
    recurrence: { ...input.recurrence, interval: 0 },
    occurrences: [input.occurrences[0]],
  });
  assert.ok(invalid.errors['recurrence.interval']);
  assert.ok(invalid.errors.occurrences);
});

test('creates a recurrence series with one shared series ID and returns its size', async () => {
  const originals = {
    insertMany: CalendarEventModel.insertMany,
  };
  const inserted = [];
  CalendarEventModel.insertMany = async (documents) => {
    inserted.push(...documents);
    return documents;
  };
  const actorId = new mongoose.Types.ObjectId();
  try {
    const res = response();
    await createCalendarEventSeries({
      user: { _id: actorId, nombre: 'Admin' },
      body: {
        event: {
          title: 'Revisar expedientes',
          type: 'file_review',
          startAt: '2026-10-14T10:00:00Z',
          endAt: '2026-10-14T11:00:00Z',
          agencyId: null,
        },
        recurrence: { frequency: 'daily', interval: 1, daysOfWeek: [], endDate: '2026-10-15' },
        occurrences: [
          { startAt: '2026-10-14T10:00:00Z', endAt: '2026-10-14T11:00:00Z' },
          { startAt: '2026-10-15T10:00:00Z', endAt: '2026-10-15T11:00:00Z' },
        ],
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.count, 2);
    assert.equal(inserted.length, 2);
    assert.equal(String(inserted[0].recurrenceSeriesId), String(inserted[1].recurrenceSeriesId));
    assert.equal(inserted[0].recurrence.frequency, 'daily');
  } finally {
    CalendarEventModel.insertMany = originals.insertMany;
  }
});

test('calendar listing overlaps date ranges, scopes non-admins to authorized events and supports mine', async () => {
  const originalFind = CalendarEventModel.find;
  const originalAgencyFind = Agency.find;
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
  Agency.find = () => ({ distinct: async () => [] });
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
    assert.deepEqual(filter.agencyId, { $in: [] });
    assert.deepEqual(filter.$or, [
      { consultantId: userId },
      { agencyId: { $in: [] } },
    ]);
    assert.equal(filter.startAt.$lt.toISOString(), '2026-10-15T00:00:00.000Z');
    assert.equal(filter.endAt.$gt.toISOString(), '2026-10-14T00:00:00.000Z');
    assert.deepEqual(res.body.data.events, []);
  } finally {
    CalendarEventModel.find = originalFind;
    Agency.find = originalAgencyFind;
  }
});

test('calendar consultant filtering includes agencies assigned to the auxiliary consultant', async () => {
  const originalFind = CalendarEventModel.find;
  const originalAgencyFind = Agency.find;
  const auxiliaryId = new mongoose.Types.ObjectId();
  const agencyId = new mongoose.Types.ObjectId();
  let filter;
  CalendarEventModel.find = (query) => {
    filter = query;
    return {
      populate() { return this; },
      sort() { return this; },
      lean: async () => [],
    };
  };
  Agency.find = (query) => {
    assert.deepEqual(query, {
      $or: [
        { consultantId: String(auxiliaryId) },
        { auxiliaryConsultantId: String(auxiliaryId) },
      ],
    });
    return { distinct: async () => [agencyId] };
  };

  try {
    const res = response();
    await getCalendarEvents({
      user: { _id: new mongoose.Types.ObjectId(), rol: 'admin' },
      query: {
        rangeStart: '2026-10-14T00:00:00Z',
        rangeEnd: '2026-10-15T00:00:00Z',
        consultantId: String(auxiliaryId),
      },
    }, res, (error) => { throw error; });

    assert.deepEqual(filter.$or, [
      { consultantId: String(auxiliaryId) },
      { agencyId: { $in: [agencyId] } },
    ]);
  } finally {
    CalendarEventModel.find = originalFind;
    Agency.find = originalAgencyFind;
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
