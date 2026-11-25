'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const AgencyMonthlyInspection = require('../src/models/AgencyMonthlyInspection');
const CalendarEvent = require('../src/models/CalendarEvent');
const MonthlyScheduleGeneration = require('../src/models/MonthlyScheduleGeneration');
const {
  MAX_TIMER_DELAY_MS,
  getTimerDelay,
} = require('../src/services/monthlyRecalendarizationWorker');
const {
  acquireMonthlyGeneration,
  buildMonthlySchedule,
  ensureMonthlyRecalendarization,
  getLocalParts,
  getNextMonthBoundary,
  getPeriodForDate,
  getPeriodForRange,
  isFederalHoliday,
  isAutomaticTargetPeriod,
  isValidSlot,
  localDateTimeToUtc,
  generateMonthlyRecalendarization,
} = require('../src/services/monthlyRecalendarization');

function event(startAt, durationMinutes, consultantId, createdAt = '2026-09-01T12:00:00Z') {
  return {
    _id: new mongoose.Types.ObjectId(),
    startAt,
    endAt: new Date(new Date(startAt).getTime() + durationMinutes * 60_000),
    consultantId,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function assignment(startAt, durationMinutes, consultantId, createdAt) {
  const sourceEvent = event(startAt, durationMinutes, consultantId, createdAt);
  return { sourceEvent, consultantId };
}

function localDate(year, month, day, hour = 0, minute = 0) {
  return localDateTimeToUtc({ year, month, day, hour, minute });
}

function getAssignment(entries, targetPeriod = '2026-11', eventIndex = 0) {
  return buildMonthlySchedule(entries, targetPeriod)[eventIndex];
}

test('period calculation uses Monterrey local time and schedules the next local month boundary', () => {
  const boundary = localDate(2026, 12, 1);
  const previousMinute = new Date(boundary.getTime() - 60_000);
  assert.equal(getPeriodForDate(previousMinute), '2026-11');
  assert.equal(getPeriodForDate(boundary), '2026-12');
  assert.equal(getNextMonthBoundary(previousMinute).getTime(), boundary.getTime());
});

test('calendar range midpoint identifies the month selected in the month grid', () => {
  assert.equal(getPeriodForRange(localDate(2026, 10, 26), localDate(2026, 12, 7)), '2026-11');
});

test('backend generation accepts the current or a future selected month, but not a past month', () => {
  const now = localDate(2026, 11, 25, 12);
  assert.equal(isAutomaticTargetPeriod('2026-11', now), true);
  assert.equal(isAutomaticTargetPeriod('2026-12', now), true);
  assert.equal(isAutomaticTargetPeriod('2027-01', now), true);
  assert.equal(isAutomaticTargetPeriod('2026-10', now), false);
});

test('monthly timer breaks long waits into supported Node timeout sizes', () => {
  const now = 0;
  assert.equal(getTimerDelay(new Date(31 * 24 * 60 * 60 * 1000), now), MAX_TIMER_DELAY_MS);
  assert.equal(getTimerDelay(new Date(10_000), now), 10_000);
});

test('preferred monthly date and time are preserved when the slot is available', () => {
  const consultantId = new mongoose.Types.ObjectId();
  const result = getAssignment([
    assignment('2026-10-12T17:00:00.000Z', 60, consultantId),
  ]);
  const scheduled = getLocalParts(result.scheduledStartAt);
  assert.equal(result.status, 'preserved');
  assert.deepEqual([scheduled.year, scheduled.month, scheduled.day, scheduled.hour], [2026, 11, 12, 11]);
});

test('a Sunday preferred date moves forward to the next working day', () => {
  const consultantId = new mongoose.Types.ObjectId();
  const result = getAssignment([
    assignment('2026-10-01T15:00:00.000Z', 60, consultantId),
  ]);
  const scheduled = getLocalParts(result.scheduledStartAt);
  assert.equal(result.status, 'rescheduled');
  assert.deepEqual([scheduled.year, scheduled.month, scheduled.day, scheduled.hour], [2026, 11, 2, 8]);
});

test('Saturday slots are retained only when the full duration fits before noon', () => {
  const consultantId = new mongoose.Types.ObjectId();
  const oneHour = getAssignment([
    assignment('2026-04-02T16:00:00.000Z', 60, consultantId),
  ], '2026-05');
  const threeHours = getAssignment([
    assignment('2026-04-02T16:00:00.000Z', 240, consultantId),
  ], '2026-05');
  const retained = getLocalParts(oneHour.scheduledStartAt);
  const moved = getLocalParts(threeHours.scheduledStartAt);
  assert.equal(oneHour.status, 'preserved');
  assert.deepEqual([retained.month, retained.day, retained.hour], [5, 2, 10]);
  assert.equal(threeHours.status, 'rescheduled');
  assert.deepEqual([moved.month, moved.day, moved.hour], [5, 4, 8]);
});

test('federal holidays are skipped and month-end dates are clamped', () => {
  assert.equal(isFederalHoliday({ year: 2026, month: 5, day: 1 }), true);
  assert.equal(isFederalHoliday({ year: 2030, month: 10, day: 1 }), true);
  const consultantId = new mongoose.Types.ObjectId();
  const holiday = getAssignment([
    assignment('2026-04-01T15:00:00.000Z', 240, consultantId),
  ], '2026-05');
  const february = buildMonthlySchedule([
    assignment('2026-01-31T16:00:00.000Z', 60, consultantId),
  ], '2026-02')[0];
  const holidayDate = getLocalParts(holiday.scheduledStartAt);
  const februaryDate = getLocalParts(february.scheduledStartAt);
  assert.deepEqual([holidayDate.month, holidayDate.day, holidayDate.hour], [5, 4, 8]);
  assert.deepEqual([februaryDate.month, februaryDate.day, februaryDate.hour], [2, 28, 10]);
});

test('15-minute gaps are allowed, shorter gaps are moved, and consultants remain independent', () => {
  const consultantId = new mongoose.Types.ObjectId();
  const otherConsultantId = new mongoose.Types.ObjectId();
  const reservations = [{
    startAt: localDate(2026, 11, 2, 9),
    endAt: localDate(2026, 11, 2, 10),
    consultantId,
  }];
  const exactGap = localDate(2026, 11, 2, 10, 15);
  const shortGap = localDate(2026, 11, 2, 10, 14);
  assert.equal(isValidSlot({ year: 2026, month: 11, day: 2 }, 10 * 60 + 15, 60, reservations), true);
  assert.equal(isValidSlot({ year: 2026, month: 11, day: 2 }, 10 * 60 + 14, 60, reservations), false);

  const sameConsultant = buildMonthlySchedule([
    assignment('2026-10-02T16:14:00.000Z', 30, consultantId),
  ], '2026-11', reservations)[0];
  const differentConsultant = buildMonthlySchedule([
    assignment('2026-10-02T16:14:00.000Z', 30, otherConsultantId),
  ], '2026-11', reservations)[0];
  assert.ok(shortGap < exactGap);
  assert.equal(sameConsultant.status, 'rescheduled');
  const moved = getLocalParts(sameConsultant.scheduledStartAt);
  assert.deepEqual([moved.hour, moved.minute], [10, 15]);
  assert.equal(differentConsultant.status, 'preserved');
});

test('events with no possible working-day slot remain unscheduled within the target month', () => {
  const consultantId = new mongoose.Types.ObjectId();
  const result = getAssignment([
    assignment('2026-10-12T14:00:00.000Z', 600, consultantId),
  ]);
  assert.equal(result.status, 'unscheduled');
  assert.equal(result.scheduledStartAt, null);
  assert.match(result.reason, /dentro del mes de destino/i);
});

test('newer events receive the preferred slot first with deterministic non-overlapping alternatives', () => {
  const consultantId = new mongoose.Types.ObjectId();
  const results = buildMonthlySchedule([
    assignment('2026-10-12T15:00:00.000Z', 60, consultantId, '2026-09-03T00:00:00Z'),
    assignment('2026-10-12T15:00:00.000Z', 60, consultantId, '2026-09-09T00:00:00Z'),
  ], '2026-11');
  const older = getLocalParts(results[1].scheduledStartAt);
  const newer = getLocalParts(results[0].scheduledStartAt);
  assert.equal(results[0].status, 'preserved');
  assert.equal(results[1].status, 'rescheduled');
  assert.deepEqual([newer.hour, newer.minute], [9, 0]);
  assert.deepEqual([older.hour, older.minute], [10, 15]);
});

test('a completed month generation cannot be acquired again', async () => {
  const originals = {
    findOneAndUpdate: MonthlyScheduleGeneration.findOneAndUpdate,
    create: MonthlyScheduleGeneration.create,
    findOne: MonthlyScheduleGeneration.findOne,
  };
  const existing = { period: '2026-11', status: 'completed' };
  let createAttempts = 0;
  MonthlyScheduleGeneration.findOneAndUpdate = async () => null;
  MonthlyScheduleGeneration.create = async () => {
    createAttempts += 1;
    const error = new Error('Duplicate period');
    error.code = 11000;
    throw error;
  };
  MonthlyScheduleGeneration.findOne = () => ({ lean: async () => existing });
  try {
    const result = await acquireMonthlyGeneration('2026-11', '2026-10', 'source-snapshot');
    assert.equal(result.generation, existing);
    assert.equal(result.lockToken, null);
    assert.equal(createAttempts, 1);
  } finally {
    MonthlyScheduleGeneration.findOneAndUpdate = originals.findOneAndUpdate;
    MonthlyScheduleGeneration.create = originals.create;
    MonthlyScheduleGeneration.findOne = originals.findOne;
  }
});

test('a completed generation can be claimed again when its source snapshot changes', async () => {
  const originalFindOneAndUpdate = MonthlyScheduleGeneration.findOneAndUpdate;
  const generation = {
    _id: new mongoose.Types.ObjectId(),
    period: '2026-11',
    status: 'processing',
  };
  let filter;
  let update;
  MonthlyScheduleGeneration.findOneAndUpdate = async (query, changes) => {
    filter = query;
    update = changes;
    return generation;
  };
  try {
    const result = await acquireMonthlyGeneration(
      '2026-11',
      '2026-10',
      'source-with-events',
    );
    assert.equal(result.generation, generation);
    assert.ok(result.lockToken);
    assert.equal(update.$set.sourceSnapshot, 'source-with-events');
    assert.ok(filter.$or.some((condition) => (
      condition.status === 'completed'
      && condition.sourceSnapshot.$ne === 'source-with-events'
    )));
  } finally {
    MonthlyScheduleGeneration.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('monthly generation is persisted once and later event triggers do not regenerate it', async () => {
  const originals = {
    generationInit: MonthlyScheduleGeneration.init,
    calendarInit: CalendarEvent.init,
    generationFindOneAndUpdate: MonthlyScheduleGeneration.findOneAndUpdate,
    generationCreate: MonthlyScheduleGeneration.create,
    generationFindOne: MonthlyScheduleGeneration.findOne,
    generationUpdateOne: MonthlyScheduleGeneration.updateOne,
    inspectionFind: AgencyMonthlyInspection.find,
    calendarFind: CalendarEvent.find,
  };
  const generation = {
    _id: new mongoose.Types.ObjectId(),
    period: '2026-11',
    status: 'processing',
  };
  let generationWrites = 0;
  let sourceReads = 0;
  let duplicateGeneration = false;
  let generationCompleted = false;
  let completedSourceSnapshot = '';
  MonthlyScheduleGeneration.init = async () => {};
  CalendarEvent.init = async () => {};
  MonthlyScheduleGeneration.findOneAndUpdate = async () => null;
  MonthlyScheduleGeneration.create = async () => {
    if (duplicateGeneration) {
      const error = new Error('Duplicate period');
      error.code = 11000;
      throw error;
    }
    return generation;
  };
  MonthlyScheduleGeneration.findOne = () => ({
    select() { return this; },
    lean: async () => (generationCompleted
      ? {
        ...generation,
        status: 'completed',
        totalEvents: 0,
        sourceSnapshot: completedSourceSnapshot,
      }
      : null),
  });
  MonthlyScheduleGeneration.updateOne = async (_filter, update) => {
    generationWrites += 1;
    assert.equal(update.$set.status, 'completed');
    generationCompleted = true;
    completedSourceSnapshot = update.$set.sourceSnapshot;
    return { modifiedCount: 1 };
  };
  AgencyMonthlyInspection.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  CalendarEvent.find = (filter) => {
    if (filter['recurrence.frequency'] === 'monthly') sourceReads += 1;
    return {
      select() { return this; },
      lean: async () => [],
    };
  };

  try {
    const first = await generateMonthlyRecalendarization(
      '2026-11',
      new Date('2026-11-01T12:00:00Z'),
    );
    duplicateGeneration = true;
    const second = await generateMonthlyRecalendarization(
      '2026-11',
      new Date('2026-11-01T12:05:00Z'),
    );
    assert.equal(first.generated, true);
    assert.equal(first.totalEvents, 0);
    assert.equal(second.generated, false);
    assert.equal(second.status, 'completed');
    assert.equal(generationWrites, 1);
    assert.equal(sourceReads, 2);
  } finally {
    MonthlyScheduleGeneration.init = originals.generationInit;
    CalendarEvent.init = originals.calendarInit;
    MonthlyScheduleGeneration.findOneAndUpdate = originals.generationFindOneAndUpdate;
    MonthlyScheduleGeneration.create = originals.generationCreate;
    MonthlyScheduleGeneration.findOne = originals.generationFindOne;
    MonthlyScheduleGeneration.updateOne = originals.generationUpdateOne;
    AgencyMonthlyInspection.find = originals.inspectionFind;
    CalendarEvent.find = originals.calendarFind;
  }
});

test('a selected future month beyond next can be generated by the backend on demand', async () => {
  const originals = {
    generationInit: MonthlyScheduleGeneration.init,
    calendarInit: CalendarEvent.init,
    generationFindOne: MonthlyScheduleGeneration.findOne,
    generationFindOneAndUpdate: MonthlyScheduleGeneration.findOneAndUpdate,
    generationCreate: MonthlyScheduleGeneration.create,
    generationUpdateOne: MonthlyScheduleGeneration.updateOne,
    inspectionFind: AgencyMonthlyInspection.find,
    calendarFind: CalendarEvent.find,
  };
  const generation = {
    _id: new mongoose.Types.ObjectId(),
    period: '2027-01',
    status: 'processing',
  };
  let completed = false;
  MonthlyScheduleGeneration.init = async () => {};
  CalendarEvent.init = async () => {};
  MonthlyScheduleGeneration.findOne = () => ({
    select() { return this; },
    lean: async () => null,
  });
  MonthlyScheduleGeneration.findOneAndUpdate = async () => null;
  MonthlyScheduleGeneration.create = async () => generation;
  MonthlyScheduleGeneration.updateOne = async () => {
    completed = true;
    return { modifiedCount: 1 };
  };
  AgencyMonthlyInspection.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  CalendarEvent.find = () => ({
    select() { return this; },
    lean: async () => [],
  });

  try {
    const result = await ensureMonthlyRecalendarization(
      '2027-01',
      new Date('2026-11-25T12:00:00Z'),
    );
    assert.equal(result.generated, true);
    assert.equal(result.period, '2027-01');
    assert.equal(completed, true);
  } finally {
    MonthlyScheduleGeneration.init = originals.generationInit;
    CalendarEvent.init = originals.calendarInit;
    MonthlyScheduleGeneration.findOne = originals.generationFindOne;
    MonthlyScheduleGeneration.findOneAndUpdate = originals.generationFindOneAndUpdate;
    MonthlyScheduleGeneration.create = originals.generationCreate;
    MonthlyScheduleGeneration.updateOne = originals.generationUpdateOne;
    AgencyMonthlyInspection.find = originals.inspectionFind;
    CalendarEvent.find = originals.calendarFind;
  }
});

test('a generated monthly visit keeps pending authorization separate from its scheduled date', async () => {
  const originals = {
    generationInit: MonthlyScheduleGeneration.init,
    calendarInit: CalendarEvent.init,
    generationFindOneAndUpdate: MonthlyScheduleGeneration.findOneAndUpdate,
    generationCreate: MonthlyScheduleGeneration.create,
    generationFindOne: MonthlyScheduleGeneration.findOne,
    generationUpdateOne: MonthlyScheduleGeneration.updateOne,
    inspectionFind: AgencyMonthlyInspection.find,
    inspectionFindOne: AgencyMonthlyInspection.findOne,
    inspectionFindOneAndUpdate: AgencyMonthlyInspection.findOneAndUpdate,
    inspectionUpdateOne: AgencyMonthlyInspection.updateOne,
    inspectionFindById: AgencyMonthlyInspection.findById,
    agencyFind: require('../src/models/Agency').find,
    calendarFind: CalendarEvent.find,
    calendarFindById: CalendarEvent.findById,
    calendarCreate: CalendarEvent.create,
  };
  const Agency = require('../src/models/Agency');
  const agencyId = new mongoose.Types.ObjectId();
  const consultantId = new mongoose.Types.ObjectId();
  const sourceEventId = new mongoose.Types.ObjectId();
  const generation = {
    _id: new mongoose.Types.ObjectId(),
    period: '2026-11',
    status: 'processing',
  };
  const sourceEvent = {
    _id: sourceEventId,
    title: 'Visita mensual · Agencia Norte',
    type: 'agency_visit',
    startAt: new Date('2026-10-15T16:00:00.000Z'),
    endAt: new Date('2026-10-15T17:00:00.000Z'),
    agencyId,
    consultantId,
    authorized: true,
    createdBy: new mongoose.Types.ObjectId(),
    updatedBy: new mongoose.Types.ObjectId(),
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-10-15T16:00:00.000Z'),
    reminders: { enabled: false, minutesBefore: [] },
  };
  const sourceRecord = {
    agencyId,
    calendarEventId: sourceEventId,
    visitStatus: 'scheduled',
  };
  const targetRecord = {
    _id: new mongoose.Types.ObjectId(),
    agencyId,
    period: '2026-11',
    authorizationStatus: 'pending',
    visitStatus: 'pending',
    scheduleStatus: 'pending',
    calendarEventId: null,
    scheduleGenerationId: null,
  };
  let generationCompleted = false;
  let completedTotalEvents = 0;
  let completedSourceSnapshot = '';
  const agency = {
    _id: agencyId,
    nombre: 'Agencia Norte',
    status: 'activa',
    consultantId,
    auxiliaryConsultantId: null,
  };
  let generatedEvent;
  MonthlyScheduleGeneration.init = async () => {};
  CalendarEvent.init = async () => {};
  MonthlyScheduleGeneration.findOneAndUpdate = async () => null;
  MonthlyScheduleGeneration.create = async () => {
    if (generationCompleted) {
      const error = new Error('Duplicate period');
      error.code = 11000;
      throw error;
    }
    return generation;
  };
  MonthlyScheduleGeneration.updateOne = async (_filter, update) => {
    if (update.$set.status === 'completed') {
      generationCompleted = true;
      completedTotalEvents = update.$set.totalEvents;
      completedSourceSnapshot = update.$set.sourceSnapshot;
    }
    return { modifiedCount: 1 };
  };
  MonthlyScheduleGeneration.findOne = () => ({
    select() { return this; },
    lean: async () => (generationCompleted
      ? {
        ...generation,
        status: 'completed',
        totalEvents: completedTotalEvents,
        sourceSnapshot: completedSourceSnapshot,
      }
      : null),
  });
  AgencyMonthlyInspection.find = () => ({
    select() { return this; },
    lean: async () => [sourceRecord],
  });
  AgencyMonthlyInspection.findOne = () => ({ lean: async () => null });
  AgencyMonthlyInspection.findOneAndUpdate = async () => targetRecord;
  AgencyMonthlyInspection.updateOne = async (_filter, update) => {
    Object.assign(targetRecord, update.$set);
    return { modifiedCount: 1 };
  };
  AgencyMonthlyInspection.findById = () => ({ lean: async () => targetRecord });
  Agency.find = () => ({
    select() { return this; },
    lean: async () => [agency],
  });
  CalendarEvent.find = (filter) => ({
    select() { return this; },
    lean: async () => (filter._id?.$in ? [sourceEvent] : []),
  });
  CalendarEvent.findById = () => ({ lean: async () => generatedEvent || null });
  CalendarEvent.create = async (input) => {
    generatedEvent = input;
    return input;
  };

  try {
    const result = await generateMonthlyRecalendarization(
      '2026-11',
      new Date('2026-11-01T12:00:00Z'),
    );
    const scheduled = getLocalParts(generatedEvent.startAt);
    assert.equal(result.rescheduledEvents, 1);
    assert.deepEqual([scheduled.year, scheduled.month, scheduled.day, scheduled.hour], [2026, 11, 17, 8]);
    assert.equal(targetRecord.visitStatus, 'scheduled');
    assert.equal(targetRecord.scheduleStatus, 'scheduled');
    assert.equal(targetRecord.authorizationStatus, 'pending');
    assert.equal(generatedEvent.authorized, false);

    await generateMonthlyRecalendarization(
      '2026-11',
      new Date('2026-11-01T12:05:00Z'),
    );
    assert.equal(targetRecord.calendarEventId, generatedEvent._id);
  } finally {
    MonthlyScheduleGeneration.init = originals.generationInit;
    CalendarEvent.init = originals.calendarInit;
    MonthlyScheduleGeneration.findOneAndUpdate = originals.generationFindOneAndUpdate;
    MonthlyScheduleGeneration.create = originals.generationCreate;
    MonthlyScheduleGeneration.findOne = originals.generationFindOne;
    MonthlyScheduleGeneration.updateOne = originals.generationUpdateOne;
    AgencyMonthlyInspection.find = originals.inspectionFind;
    AgencyMonthlyInspection.findOne = originals.inspectionFindOne;
    AgencyMonthlyInspection.findOneAndUpdate = originals.inspectionFindOneAndUpdate;
    AgencyMonthlyInspection.updateOne = originals.inspectionUpdateOne;
    AgencyMonthlyInspection.findById = originals.inspectionFindById;
    Agency.find = originals.agencyFind;
    CalendarEvent.find = originals.calendarFind;
    CalendarEvent.findById = originals.calendarFindById;
    CalendarEvent.create = originals.calendarCreate;
  }
});
