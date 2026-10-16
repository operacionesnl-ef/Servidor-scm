'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyMonthlyInspection = require('../src/models/AgencyMonthlyInspection');
const AgencyNote = require('../src/models/AgencyNote');
const AgencyPersonalization = require('../src/models/AgencyPersonalization');
const CalendarEvent = require('../src/models/CalendarEvent');
const SentEmail = require('../src/models/SentEmail');
const User = require('../src/models/User');
const AgencyHistory = require('../src/models/AgencyHistory');
const { deleteAgency } = require('../src/controllers/agencyController');
const {
  scheduleMonthlyVisit,
  getMonthlyInspectionOverview,
  updateMonthlyVisitStatus,
} = require('../src/controllers/agencyMonthlyInspectionController');
const { appendAgencyNote } = require('../src/controllers/agencyNoteController');
const { createAgency, validateAgencyInput } = require('../src/controllers/agencyController');
const pushNotificationService = require('../src/services/pushNotificationService');
const { dispatchMonthlyInspectionReminders } = require('../src/services/agencyMonthlyInspectionReminders');

const originalAgencyHistoryCreate = AgencyHistory.create;
beforeEach(() => { AgencyHistory.create = async (entry) => entry; });
afterEach(() => { AgencyHistory.create = originalAgencyHistoryCreate; });

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('agency creation accepts the requested minimum and retains optional legacy fields', () => {
  const minimal = validateAgencyInput({
    nombre: 'Agencia Nueva',
    entidadFederativa: 'Nuevo León',
    status: 'activa',
  }, false);
  assert.deepEqual(minimal.errors, {});
  assert.deepEqual(minimal.value, {
    nombre: 'Agencia Nueva',
    entidadFederativa: 'Nuevo León',
    status: 'activa',
  });

  test('only administrators can assign or remove the agency responsible consultant', async () => {
    const res = response();
    await createAgency({
      user: { _id: new mongoose.Types.ObjectId(), rol: 'consultor' },
      body: {
        nombre: 'Agencia Norte',
        entidadFederativa: 'Nuevo León',
        consultantId: new mongoose.Types.ObjectId().toString(),
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 403);
  });

  const legacy = validateAgencyInput({
    nombre: 'Agencia Legacy',
    entidadFederativa: 'Nuevo León',
    correo: 'LEGACY@example.com',
    archivos: {
      archivo1: { nombre: 'ANX.pdf', ruta: 'drive-file-id' },
    },
  }, false);
  assert.deepEqual(legacy.errors, {});
  assert.equal(legacy.value.correo, 'legacy@example.com');
  assert.equal(Agency.schema.path('consultantId').options.ref, 'User');
  assert.equal(Agency.schema.path('correo').isRequired, false);
});

test('monthly inspection schema constrains period, authorization and completion states', () => {
  const base = {
    agencyId: new mongoose.Types.ObjectId(),
    period: '2026-10',
  };
  const valid = new AgencyMonthlyInspection(base);
  assert.equal(valid.authorizationStatus, 'pending');
  assert.equal(valid.visitStatus, 'scheduled');
  assert.equal(valid.validateSync(), undefined);

  valid.period = '2026-13';
  valid.authorizationStatus = 'approved';
  valid.visitStatus = 'done';
  const errors = valid.validateSync().errors;
  assert.ok(errors.period);
  assert.ok(errors.authorizationStatus);
  assert.ok(errors.visitStatus);
  assert.ok(AgencyMonthlyInspection.schema.indexes()
    .some(([index, options]) => index.agencyId === 1 && index.period === 1 && options.unique));
});

test('appended agency note always uses the authenticated author and cannot be edited here', async () => {
  const originalExists = Agency.exists;
  const originalCreate = AgencyNote.create;
  const noteId = new mongoose.Types.ObjectId();
  let persisted;
  Agency.exists = async () => true;
  AgencyNote.create = async (input) => {
    persisted = input;
    return { _id: noteId, text: input.text, createdAt: new Date('2026-10-14T00:00:00Z') };
  };
  try {
    const authorId = new mongoose.Types.ObjectId();
    const res = response();
    await appendAgencyNote({
      params: { id: new mongoose.Types.ObjectId().toString() },
      user: { _id: authorId, nombre: 'Consultor' },
      body: { text: '   Se revisó documentación.   ' },
    }, res, (error) => { throw error; });
    assert.deepEqual(persisted.authorId, authorId);
    assert.equal(persisted.text, 'Se revisó documentación.');
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.text, 'Se revisó documentación.');
  } finally {
    Agency.exists = originalExists;
    AgencyNote.create = originalCreate;
  }
});

test('monthly visit uses agency consultant relation and creates exactly one calendar event link', async () => {
  const originals = {
    agencyFindById: Agency.findById,
    inspectionUpdateOne: AgencyMonthlyInspection.updateOne,
    inspectionFindOne: AgencyMonthlyInspection.findOne,
    inspectionFindById: AgencyMonthlyInspection.findById,
    calendarExists: CalendarEvent.exists,
    calendarCreate: CalendarEvent.create,
  };
  const agencyId = new mongoose.Types.ObjectId();
  const consultantId = new mongoose.Types.ObjectId();
  const recordId = new mongoose.Types.ObjectId();
  let createdEvent;
  let reserveCount = 0;
  Agency.findById = () => ({ select: async () => ({
    _id: agencyId,
    nombre: 'Agencia Norte',
    consultantId,
    status: 'activa',
  }) });
  AgencyMonthlyInspection.updateOne = async () => {
    reserveCount += 1;
    return { modifiedCount: 1 };
  };
  AgencyMonthlyInspection.findOne = async () => ({
    _id: recordId,
    agencyId,
    period: '2026-10',
    authorizationStatus: 'authorized',
    visitStatus: 'scheduled',
    calendarEventId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  AgencyMonthlyInspection.findById = () => ({
    lean: async () => ({
      _id: recordId,
      agencyId,
      period: '2026-10',
      authorizationStatus: 'authorized',
      visitStatus: 'scheduled',
      calendarEventId: createdEvent?._id,
    }),
  });
  CalendarEvent.exists = async () => false;
  CalendarEvent.create = async (input) => {
    createdEvent = input;
    return input;
  };
  try {
    const res = response();
    await scheduleMonthlyVisit({
      params: { id: String(agencyId), period: '2026-10' },
      user: { _id: new mongoose.Types.ObjectId() },
      body: {
        startAt: '2026-10-20T10:00:00-06:00',
        endAt: '2026-10-20T11:00:00-06:00',
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(createdEvent.agencyId, agencyId);
    assert.deepEqual(createdEvent.consultantId, consultantId);
    assert.equal(createdEvent.type, 'agency_visit');
    assert.equal(res.body.data.record.calendarEventId, String(createdEvent._id));
    assert.equal(reserveCount, 2);
  } finally {
    Agency.findById = originals.agencyFindById;
    AgencyMonthlyInspection.updateOne = originals.inspectionUpdateOne;
    AgencyMonthlyInspection.findOne = originals.inspectionFindOne;
    AgencyMonthlyInspection.findById = originals.inspectionFindById;
    CalendarEvent.exists = originals.calendarExists;
    CalendarEvent.create = originals.calendarCreate;
  }
});

test('rescheduling a completed inspection with a stale event link reopens its monthly confirmation', async () => {
  const originals = {
    agencyFindById: Agency.findById,
    inspectionUpdateOne: AgencyMonthlyInspection.updateOne,
    inspectionFindOne: AgencyMonthlyInspection.findOne,
    inspectionFindById: AgencyMonthlyInspection.findById,
    calendarExists: CalendarEvent.exists,
    calendarCreate: CalendarEvent.create,
  };
  const agencyId = new mongoose.Types.ObjectId();
  const recordId = new mongoose.Types.ObjectId();
  const staleEventId = new mongoose.Types.ObjectId();
  const record = {
    _id: recordId,
    agencyId,
    period: '2026-10',
    authorizationStatus: 'authorized',
    visitStatus: 'completed',
    calendarEventId: staleEventId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let createdEvent;
  Agency.findById = () => ({
    select: async () => ({
      _id: agencyId,
      nombre: 'Agencia Norte',
      consultantId: new mongoose.Types.ObjectId(),
    }),
  });
  AgencyMonthlyInspection.updateOne = async (filter, update) => {
    if (filter._id && filter.calendarEventId === staleEventId) {
      record.calendarEventId = null;
      record.visitStatus = 'scheduled';
    } else if (filter._id && filter.calendarEventId === null) {
      record.calendarEventId = update.$set.calendarEventId;
      record.visitStatus = update.$set.visitStatus;
    }
    return { modifiedCount: 1 };
  };
  AgencyMonthlyInspection.findOne = async () => record;
  AgencyMonthlyInspection.findById = () => ({ lean: async () => record });
  CalendarEvent.exists = async ({ _id }) => Boolean(createdEvent && _id.equals(createdEvent._id));
  CalendarEvent.create = async (input) => {
    createdEvent = input;
    return input;
  };

  try {
    const res = response();
    await scheduleMonthlyVisit({
      params: { id: String(agencyId), period: '2026-10' },
      user: { _id: new mongoose.Types.ObjectId() },
      body: {
        startAt: '2026-10-20T10:00:00-06:00',
        endAt: '2026-10-20T11:00:00-06:00',
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(record.visitStatus, 'scheduled');
    assert.equal(res.body.data.record.visitStatus, 'scheduled');
    assert.equal(res.body.data.record.calendarEventId, String(createdEvent._id));
  } finally {
    Agency.findById = originals.agencyFindById;
    AgencyMonthlyInspection.updateOne = originals.inspectionUpdateOne;
    AgencyMonthlyInspection.findOne = originals.inspectionFindOne;
    AgencyMonthlyInspection.findById = originals.inspectionFindById;
    CalendarEvent.exists = originals.calendarExists;
    CalendarEvent.create = originals.calendarCreate;
  }
});

test('monthly visit cannot be scheduled before the monthly authorization is approved', async () => {
  const originalAgencyFindById = Agency.findById;
  const originalInspectionFindOne = AgencyMonthlyInspection.findOne;
  const agencyId = new mongoose.Types.ObjectId();
  Agency.findById = () => ({
    select: async () => ({
      _id: agencyId,
      nombre: 'Agencia Norte',
      consultantId: new mongoose.Types.ObjectId(),
    }),
  });
  AgencyMonthlyInspection.findOne = async () => ({
    authorizationStatus: 'unauthorized',
  });

  try {
    const res = response();
    await scheduleMonthlyVisit({
      params: { id: String(agencyId), period: '2026-10' },
      user: { _id: new mongoose.Types.ObjectId() },
      body: {
        startAt: '2026-10-20T10:00:00-06:00',
        endAt: '2026-10-20T11:00:00-06:00',
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'MONTHLY_AUTHORIZATION_REQUIRED');
    assert.match(res.body.message, /autorización.*autorizada/i);
  } finally {
    Agency.findById = originalAgencyFindById;
    AgencyMonthlyInspection.findOne = originalInspectionFindOne;
  }
});

test('monthly visit cannot be marked complete without a linked calendar event', async () => {
  const originalFindOne = AgencyMonthlyInspection.findOne;
  AgencyMonthlyInspection.findOne = async () => ({
    calendarEventId: null,
  });
  try {
    const res = response();
    await updateMonthlyVisitStatus({
      params: { id: new mongoose.Types.ObjectId().toString(), period: '2026-10' },
      user: { _id: new mongoose.Types.ObjectId() },
      body: { status: 'completed' },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.errors.status, /linked calendar visit/i);
  } finally {
    AgencyMonthlyInspection.findOne = originalFindOne;
  }
});

test('monthly visit completion is persisted only against its linked calendar event', async () => {
  const originals = {
    inspectionFindOne: AgencyMonthlyInspection.findOne,
    calendarExists: CalendarEvent.exists,
  };
  const eventId = new mongoose.Types.ObjectId();
  let saved = false;
  const record = {
    agencyId: new mongoose.Types.ObjectId(),
    calendarEventId: eventId,
    visitStatus: 'scheduled',
    save: async function save() { saved = true; },
  };
  AgencyMonthlyInspection.findOne = async () => record;
  CalendarEvent.exists = async (query) => query._id.equals(eventId);
  try {
    const res = response();
    await updateMonthlyVisitStatus({
      params: { id: new mongoose.Types.ObjectId().toString(), period: '2026-10' },
      user: { _id: new mongoose.Types.ObjectId() },
      body: { status: 'completed' },
    }, res, (error) => { throw error; });
    assert.equal(saved, true);
    assert.equal(record.visitStatus, 'completed');
    assert.equal(res.body.data.visitStatus, 'completed');
  } finally {
    AgencyMonthlyInspection.findOne = originals.inspectionFindOne;
    CalendarEvent.exists = originals.calendarExists;
  }
});

test('monthly inspection overview flags missing calendar links and pending confirmations', async () => {
  const originals = {
    agencyFind: Agency.find,
    inspectionFind: AgencyMonthlyInspection.find,
    calendarFind: CalendarEvent.find,
  };
  const scheduledAgencyId = new mongoose.Types.ObjectId();
  const missingEventAgencyId = new mongoose.Types.ObjectId();
  const completedAgencyId = new mongoose.Types.ObjectId();
  const scheduledEventId = new mongoose.Types.ObjectId();
  const missingEventId = new mongoose.Types.ObjectId();
  const completedEventId = new mongoose.Types.ObjectId();
  Agency.find = () => ({
    select() {
      return this;
    },
    lean: async () => [
      { _id: scheduledAgencyId, nombre: 'Agencia programada' },
      { _id: missingEventAgencyId, nombre: 'Agencia sin evento' },
      { _id: completedAgencyId, nombre: 'Agencia completada' },
    ],
  });
  AgencyMonthlyInspection.find = () => ({
    select() {
      return this;
    },
    lean: async () => [
      {
        agencyId: scheduledAgencyId,
        authorizationStatus: 'authorized',
        visitStatus: 'scheduled',
        calendarEventId: scheduledEventId,
      },
      {
        agencyId: missingEventAgencyId,
        authorizationStatus: 'pending',
        visitStatus: 'scheduled',
        calendarEventId: missingEventId,
      },
      {
        agencyId: completedAgencyId,
        authorizationStatus: 'authorized',
        visitStatus: 'completed',
        calendarEventId: completedEventId,
      },
    ],
  });
  CalendarEvent.find = (query) => ({
    select() {
      return this;
    },
    lean: async () => [
      { _id: scheduledEventId, agencyId: scheduledAgencyId },
      { _id: completedEventId, agencyId: completedAgencyId },
    ].filter((event) => query._id.$in.some((id) => id.equals(event._id))),
  });

  try {
    const res = response();
    await getMonthlyInspectionOverview({
      params: { period: '2026-10' },
    }, res, (error) => { throw error; });
    assert.equal(res.body.data.period, '2026-10');
    assert.deepEqual(res.body.data.agencies.map((agency) => [
      agency.authorizationStatus,
      agency.visitStatus,
      agency.calendarEventExists,
    ]), [
      ['authorized', 'scheduled', true],
      ['pending', 'scheduled', false],
      ['authorized', 'completed', true],
    ]);
  } finally {
    Agency.find = originals.agencyFind;
    AgencyMonthlyInspection.find = originals.inspectionFind;
    CalendarEvent.find = originals.calendarFind;
  }
});

test('deleting an agency also removes its calendar and monthly inspection records', async () => {
  const originals = {
    agencyFindById: Agency.findById,
    sentEmailExists: SentEmail.exists,
    eventDeleteMany: CalendarEvent.deleteMany,
    inspectionDeleteMany: AgencyMonthlyInspection.deleteMany,
    noteDeleteMany: AgencyNote.deleteMany,
    personalizationDeleteMany: AgencyPersonalization.deleteMany,
  };
  const agencyId = new mongoose.Types.ObjectId();
  const deleted = [];
  const agency = {
    _id: agencyId,
    toObject: () => ({ _id: agencyId }),
    deleteOne: async () => { deleted.push('agency'); },
  };
  Agency.findById = async () => agency;
  SentEmail.exists = async () => false;
  CalendarEvent.deleteMany = async (query) => {
    deleted.push('events');
    assert.equal(String(query.agencyId), String(agencyId));
  };
  AgencyMonthlyInspection.deleteMany = async () => { deleted.push('inspections'); };
  AgencyNote.deleteMany = async () => { deleted.push('notes'); };
  AgencyPersonalization.deleteMany = async () => { deleted.push('personalization'); };

  try {
    const res = response();
    await deleteAgency({
      params: { id: String(agencyId) },
      user: { _id: new mongoose.Types.ObjectId() },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(new Set(deleted), new Set(['events', 'inspections', 'notes', 'personalization', 'agency']));
  } finally {
    Agency.findById = originals.agencyFindById;
    SentEmail.exists = originals.sentEmailExists;
    CalendarEvent.deleteMany = originals.eventDeleteMany;
    AgencyMonthlyInspection.deleteMany = originals.inspectionDeleteMany;
    AgencyNote.deleteMany = originals.noteDeleteMany;
    AgencyPersonalization.deleteMany = originals.personalizationDeleteMany;
  }
});

test('monthly pending reminders send once per agency-period across repeated worker runs', async () => {
  const originals = {
    agencyFind: Agency.find,
    inspectionUpdateOne: AgencyMonthlyInspection.updateOne,
    inspectionFindOneAndUpdate: AgencyMonthlyInspection.findOneAndUpdate,
    userExists: User.exists,
    push: pushNotificationService.sendPushToUser,
  };
  const agency = {
    _id: new mongoose.Types.ObjectId(),
    nombre: 'Agencia Sur',
    consultantId: new mongoose.Types.ObjectId(),
  };
  const claimed = new Set();
  let pushes = 0;
  Agency.find = () => ({ select() { return this; }, lean: async () => [agency] });
  AgencyMonthlyInspection.updateOne = async () => ({ modifiedCount: 1 });
  AgencyMonthlyInspection.findOneAndUpdate = async (filter) => {
    const key = `${filter.agencyId}:${filter.period}`;
    if (claimed.has(key)) return null;
    claimed.add(key);
    return { _id: new mongoose.Types.ObjectId() };
  };
  User.exists = async () => true;
  pushNotificationService.sendPushToUser = async () => {
    pushes += 1;
    return { total: 1, sent: 1 };
  };
  try {
    const now = new Date('2026-10-14T16:00:00-06:00');
    const first = await dispatchMonthlyInspectionReminders(now);
    const second = await dispatchMonthlyInspectionReminders(now);
    assert.equal(first.dispatched, 1);
    assert.equal(second.dispatched, 0);
    assert.equal(pushes, 1);
    assert.equal(first.period, '2026-10');
  } finally {
    Agency.find = originals.agencyFind;
    AgencyMonthlyInspection.updateOne = originals.inspectionUpdateOne;
    AgencyMonthlyInspection.findOneAndUpdate = originals.inspectionFindOneAndUpdate;
    User.exists = originals.userExists;
    pushNotificationService.sendPushToUser = originals.push;
  }
});
