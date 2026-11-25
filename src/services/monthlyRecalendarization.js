'use strict';

const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const Agency = require('../models/Agency');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const CalendarEvent = require('../models/CalendarEvent');
const MonthlyScheduleGeneration = require('../models/MonthlyScheduleGeneration');
const { logEvent } = require('../utils/consoleLogger');

const TIME_ZONE = 'America/Monterrey';
const MINIMUM_GAP_MINUTES = 15;
const GENERATION_LOCK_MS = 30 * 60 * 1000;
const inFlightGenerations = new Map();
const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function getLocalParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const values = Object.fromEntries(dateTimeFormatter.formatToParts(date)
    .map(({ type, value: partValue }) => [type, Number(partValue)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
    millisecond: date.getMilliseconds(),
  };
}

function localDateTimeToUtc({ year, month, day, hour = 0, minute = 0 }) {
  const desiredUtcValue = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desiredUtcValue;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = getLocalParts(new Date(timestamp));
    if (!local) throw new Error('Unable to resolve a local calendar date.');
    const localAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
    );
    const difference = desiredUtcValue - localAsUtc;
    if (difference === 0) return new Date(timestamp);
    timestamp += difference;
  }
  return new Date(timestamp);
}

function getPeriodParts(period) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period || '');
  if (!match) throw new Error('Period must use YYYY-MM format.');
  return { year: Number(match[1]), month: Number(match[2]) };
}

function getPeriodForDate(value = new Date()) {
  const parts = getLocalParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

function getPreviousPeriod(period) {
  const { year, month } = getPeriodParts(period);
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  return `${previousYear}-${String(previousMonth).padStart(2, '0')}`;
}

function getPeriodForRange(rangeStart, rangeEnd) {
  const midpoint = new Date((rangeStart.getTime() + rangeEnd.getTime()) / 2);
  return getPeriodForDate(midpoint);
}

function isAutomaticTargetPeriod(period, now = new Date()) {
  return period >= getPeriodForDate(now);
}

function getPeriodRange(period) {
  const { year, month } = getPeriodParts(period);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return {
    start: localDateTimeToUtc({ year, month, day: 1 }),
    end: localDateTimeToUtc({ year: nextYear, month: nextMonth, day: 1 }),
  };
}

function getNextMonthBoundary(value = new Date()) {
  const { year, month } = getLocalParts(value);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return localDateTimeToUtc({ year: nextYear, month: nextMonth, day: 1 });
}

function monthDayCount(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getIdealDate(sourceStartAt, targetPeriod) {
  const source = getLocalParts(sourceStartAt);
  const target = getPeriodParts(targetPeriod);
  return {
    year: target.year,
    month: target.month,
    day: Math.min(source.day, monthDayCount(target.year, target.month)),
  };
}

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekday({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isNthWeekday({ year, month, day }, expectedWeekday, occurrence) {
  return weekday({ year, month, day }) === expectedWeekday
    && Math.floor((day - 1) / 7) + 1 === occurrence;
}

function isFederalHoliday(date) {
  const { year, month, day } = date;
  if ((month === 1 && day === 1)
    || (month === 5 && day === 1)
    || (month === 9 && day === 16)
    || (month === 12 && day === 25)
    || ((year - 2024) % 6 === 0 && month === 10 && day === 1)) return true;
  return (month === 2 && isNthWeekday(date, 1, 1))
    || (month === 3 && isNthWeekday(date, 1, 3))
    || (month === 11 && isNthWeekday(date, 1, 3));
}

function getWorkingHours(date) {
  if (isFederalHoliday(date)) return null;
  const day = weekday(date);
  if (day >= 1 && day <= 5) return { opening: 8 * 60, closing: 17 * 60 };
  if (day === 6) return { opening: 9 * 60, closing: 12 * 60 };
  return null;
}

function addCalendarDays(date, amount) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function isValidSlot(date, startMinute, durationMinutes, reservations) {
  const workingHours = getWorkingHours(date);
  if (!workingHours || !Number.isFinite(durationMinutes) || durationMinutes <= 0
    || startMinute < workingHours.opening
    || startMinute + durationMinutes > workingHours.closing) return false;

  const startAt = localDateTimeToUtc({
    ...date,
    hour: Math.floor(startMinute / 60),
    minute: startMinute % 60,
  });
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
  const margin = MINIMUM_GAP_MINUTES * 60_000;
  return !reservations.some((reservation) => (
    startAt.getTime() < reservation.endAt.getTime() + margin
    && endAt.getTime() > reservation.startAt.getTime() - margin
  ));
}

function findFirstAvailableStart(date, durationMinutes, reservations, preferredStartMinute = null) {
  const workingHours = getWorkingHours(date);
  if (!workingHours || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const firstAllowedMinute = preferredStartMinute !== null
    && preferredStartMinute >= workingHours.opening
    && preferredStartMinute < workingHours.closing
    ? preferredStartMinute
    : workingHours.opening;
  const openingAt = localDateTimeToUtc({
    ...date,
    hour: Math.floor(firstAllowedMinute / 60),
    minute: firstAllowedMinute % 60,
  });
  const closingAt = localDateTimeToUtc({
    ...date,
    hour: Math.floor(workingHours.closing / 60),
    minute: workingHours.closing % 60,
  });
  const margin = MINIMUM_GAP_MINUTES * 60_000;
  let candidateAt = openingAt;
  const sortedReservations = [...reservations]
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());

  for (const reservation of sortedReservations) {
    if (candidateAt.getTime() >= reservation.endAt.getTime() + margin) continue;
    const candidateEndAt = new Date(candidateAt.getTime() + durationMinutes * 60_000);
    if (candidateEndAt.getTime() + margin <= reservation.startAt.getTime()) break;
    candidateAt = new Date(reservation.endAt.getTime() + margin);
  }

  const endAt = new Date(candidateAt.getTime() + durationMinutes * 60_000);
  if (endAt.getTime() > closingAt.getTime()) return null;
  const localStart = getLocalParts(candidateAt);
  return localStart ? localStart.hour * 60 + localStart.minute : null;
}

function findNextAvailableSlot(
  idealDate,
  targetPeriod,
  durationMinutes,
  reservations,
  preferredStartMinute,
) {
  const { year, month } = getPeriodParts(targetPeriod);
  const lastDay = monthDayCount(year, month);
  for (let day = idealDate.day; day <= lastDay; day += 1) {
    const date = { year, month, day };
    const startMinute = findFirstAvailableStart(
      date,
      durationMinutes,
      reservations,
      day === idealDate.day ? preferredStartMinute : null,
    );
    if (startMinute !== null) return { date, startMinute };
  }
  return null;
}

function compareCreationNewestFirst(left, right) {
  const leftCreatedAt = new Date(left.createdAt || left.sourceEvent.createdAt || 0).getTime();
  const rightCreatedAt = new Date(right.createdAt || right.sourceEvent.createdAt || 0).getTime();
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt - leftCreatedAt;
  const leftUpdatedAt = new Date(left.sourceEvent.updatedAt || 0).getTime();
  const rightUpdatedAt = new Date(right.sourceEvent.updatedAt || 0).getTime();
  if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
  const leftStableId = left.sourceEvent.recurrenceSeriesId || left.agencyId || left.sourceEvent._id;
  const rightStableId = right.sourceEvent.recurrenceSeriesId || right.agencyId || right.sourceEvent._id;
  return String(leftStableId).localeCompare(String(rightStableId));
}

function buildMonthlySchedule(entries, targetPeriod, existingEvents = []) {
  const groups = new Map();
  for (const entry of entries) {
    const consultantId = entry.consultantId ? String(entry.consultantId) : '';
    if (!groups.has(consultantId)) groups.set(consultantId, []);
    groups.get(consultantId).push(entry);
  }
  const reservationsByConsultant = new Map();
  for (const event of existingEvents) {
    if (!event.consultantId || !event.startAt || !event.endAt) continue;
    const consultantId = String(event.consultantId);
    if (!reservationsByConsultant.has(consultantId)) reservationsByConsultant.set(consultantId, []);
    reservationsByConsultant.get(consultantId).push({
      startAt: new Date(event.startAt),
      endAt: new Date(event.endAt),
    });
  }

  const assignments = [];
  for (const [consultantId, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const reservations = reservationsByConsultant.get(consultantId) || [];
    for (const entry of group.sort(compareCreationNewestFirst)) {
      const sourceStartAt = new Date(entry.sourceEvent.startAt);
      const sourceEndAt = new Date(entry.sourceEvent.endAt);
      const durationMinutes = (sourceEndAt.getTime() - sourceStartAt.getTime()) / 60_000;
      const sourceLocal = getLocalParts(sourceStartAt);
      const idealDate = getIdealDate(sourceStartAt, targetPeriod);
      const idealStartAt = localDateTimeToUtc({
        ...idealDate,
        hour: sourceLocal.hour,
        minute: sourceLocal.minute,
      });

      if (!consultantId) {
        assignments.push({
          ...entry,
          idealStartAt,
          scheduledStartAt: null,
          scheduledEndAt: null,
          status: 'unscheduled',
          reason: 'El evento no tiene un consultor asignado.',
        });
        continue;
      }

      let selectedDate = idealDate;
      let selectedStartMinute = sourceLocal.hour * 60 + sourceLocal.minute;
      let status = 'preserved';
      if (!isValidSlot(selectedDate, selectedStartMinute, durationMinutes, reservations)) {
        const alternative = findNextAvailableSlot(
          idealDate,
          targetPeriod,
          durationMinutes,
          reservations,
          sourceLocal.hour * 60 + sourceLocal.minute,
        );
        if (!alternative) {
          assignments.push({
            ...entry,
            idealStartAt,
            scheduledStartAt: null,
            scheduledEndAt: null,
            status: 'unscheduled',
            reason: 'No se encontró disponibilidad dentro del mes de destino.',
          });
          continue;
        }
        selectedDate = alternative.date;
        selectedStartMinute = alternative.startMinute;
        status = 'rescheduled';
      }

      const scheduledStartAt = localDateTimeToUtc({
        ...selectedDate,
        hour: Math.floor(selectedStartMinute / 60),
        minute: selectedStartMinute % 60,
      });
      const scheduledEndAt = new Date(scheduledStartAt.getTime() + durationMinutes * 60_000);
      reservations.push({ startAt: scheduledStartAt, endAt: scheduledEndAt });
      assignments.push({
        ...entry,
        idealStartAt,
        scheduledStartAt,
        scheduledEndAt,
        status,
        reason: '',
      });
    }
  }
  return assignments;
}

function isMonthlyRecurrenceDue(event, targetPeriod) {
  const recurrence = event.recurrence;
  if (recurrence?.frequency !== 'monthly' || recurrence.interval !== 1) return false;
  const idealDate = getIdealDate(event.startAt, targetPeriod);
  return !recurrence.endDate || dateKey(idealDate) <= recurrence.endDate;
}

function serializeResult(assignment, targetEventId = null, status = assignment.status) {
  return {
    agencyId: assignment.agencyId || null,
    sourceEventId: assignment.sourceEvent._id,
    targetEventId,
    recurrenceSeriesId: assignment.sourceEvent.recurrenceSeriesId || null,
    status,
    idealStartAt: assignment.idealStartAt,
    scheduledStartAt: assignment.scheduledStartAt,
    scheduledEndAt: assignment.scheduledEndAt,
    reason: assignment.reason || '',
  };
}

function getPreferredStartAt(sourceEvent, targetPeriod) {
  const idealDate = getIdealDate(sourceEvent.startAt, targetPeriod);
  const sourceLocal = getLocalParts(sourceEvent.startAt);
  return localDateTimeToUtc({
    ...idealDate,
    hour: sourceLocal.hour,
    minute: sourceLocal.minute,
  });
}

function countResults(results) {
  return {
    totalEvents: results.length,
    preservedEvents: results.filter((result) => result.status === 'preserved').length,
    rescheduledEvents: results.filter((result) => result.status === 'rescheduled').length,
    unscheduledEvents: results.filter((result) => result.status === 'unscheduled').length,
    existingEvents: results.filter((result) => result.status === 'already_scheduled').length,
  };
}

function getSourceSnapshot(entries) {
  const rows = entries.map((entry) => JSON.stringify([
    entry.kind,
    String(entry.agencyId || ''),
    String(entry.consultantId || ''),
    String(entry.sourceEvent._id),
    new Date(entry.sourceEvent.startAt).toISOString(),
    new Date(entry.sourceEvent.endAt).toISOString(),
    entry.sourceEvent.createdAt ? new Date(entry.sourceEvent.createdAt).toISOString() : '',
    entry.sourceEvent.updatedAt ? new Date(entry.sourceEvent.updatedAt).toISOString() : '',
    entry.sourceEvent.recurrenceSeriesId ? String(entry.sourceEvent.recurrenceSeriesId) : '',
  ])).sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

async function acquireMonthlyGeneration(period, sourcePeriod, sourceSnapshot, now = new Date()) {
  const lockToken = new mongoose.Types.ObjectId().toString();
  const lockExpiresAt = new Date(now.getTime() + GENERATION_LOCK_MS);
  const reclaimed = await MonthlyScheduleGeneration.findOneAndUpdate(
    {
      period,
      $or: [
        { status: 'failed' },
        { status: 'processing', lockExpiresAt: { $lte: now } },
        {
          status: 'completed',
          sourceSnapshot: { $ne: sourceSnapshot },
        },
      ],
    },
    {
      $set: {
        sourcePeriod,
        sourceSnapshot,
        status: 'processing',
        lockToken,
        lockExpiresAt,
        startedAt: now,
        completedAt: null,
        error: '',
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  );
  if (reclaimed) return { generation: reclaimed, lockToken };

  try {
    const generation = await MonthlyScheduleGeneration.create({
      period,
      sourcePeriod,
      sourceSnapshot,
      status: 'processing',
      attempts: 1,
      lockToken,
      lockExpiresAt,
      startedAt: now,
    });
    return { generation, lockToken };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await MonthlyScheduleGeneration.findOne({ period }).lean();
    if (!existing) throw error;
    return { generation: existing, lockToken: null };
  }
}

async function loadSourceEntries(sourcePeriod, targetPeriod) {
  const sourceRange = getPeriodRange(sourcePeriod);
  const sourceInspections = await AgencyMonthlyInspection.find({
    period: sourcePeriod,
    calendarEventId: { $ne: null },
    visitStatus: { $in: ['scheduled', 'completed'] },
  })
    .select('agencyId calendarEventId visitStatus')
    .lean();
  const inspectionEventIds = sourceInspections.map((record) => record.calendarEventId);
  const sourceAgencyIds = sourceInspections.map((record) => record.agencyId);
  const [inspectionEvents, agencies, recurringEvents] = await Promise.all([
    inspectionEventIds.length
      ? CalendarEvent.find({
        _id: { $in: inspectionEventIds },
        type: 'agency_visit',
        startAt: { $gte: sourceRange.start, $lt: sourceRange.end },
      }).lean()
      : [],
    sourceAgencyIds.length
      ? Agency.find({
        _id: { $in: sourceAgencyIds },
        status: 'activa',
        consultantId: { $ne: null },
      }).select('_id nombre consultantId auxiliaryConsultantId status').lean()
      : [],
    CalendarEvent.find({
      startAt: { $gte: sourceRange.start, $lt: sourceRange.end },
      recurrenceSeriesId: { $ne: null },
      'recurrence.frequency': 'monthly',
      'recurrence.interval': 1,
    }).lean(),
  ]);
  const agencyById = new Map(agencies.map((agency) => [String(agency._id), agency]));
  const eventById = new Map(inspectionEvents.map((event) => [String(event._id), event]));
  const linkedEventIds = new Set(inspectionEvents.map((event) => String(event._id)));
  const entries = [];

  for (const record of sourceInspections) {
    const sourceEvent = eventById.get(String(record.calendarEventId));
    const agency = agencyById.get(String(record.agencyId));
    if (!sourceEvent || !agency) continue;
    entries.push({
      kind: 'agency_visit',
      agencyId: agency._id,
      agency,
      sourceInspection: record,
      sourceEvent,
      consultantId: sourceEvent.consultantId || agency.consultantId,
    });
  }

  const dueSeriesIds = new Set();
  for (const sourceEvent of recurringEvents) {
    const seriesId = String(sourceEvent.recurrenceSeriesId);
    if (linkedEventIds.has(String(sourceEvent._id))
      || dueSeriesIds.has(seriesId)
      || !isMonthlyRecurrenceDue(sourceEvent, targetPeriod)) continue;
    dueSeriesIds.add(seriesId);
    entries.push({
      kind: 'calendar_event',
      agencyId: sourceEvent.agencyId || null,
      sourceEvent,
      consultantId: sourceEvent.consultantId,
    });
  }
  return entries;
}

async function getTargetInspection(entry, period) {
  let record;
  try {
    record = await AgencyMonthlyInspection.findOneAndUpdate(
      { agencyId: entry.agencyId, period },
      {
        $setOnInsert: {
          authorizationStatus: 'pending',
          visitStatus: 'pending',
          scheduleStatus: 'pending',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    record = await AgencyMonthlyInspection.findOne({
      agencyId: entry.agencyId,
      period,
    });
  }
  return record;
}

async function persistAssignment(assignment, period, generation) {
  if (assignment.kind === 'calendar_event') {
    if (assignment.status === 'unscheduled') return serializeResult(assignment);
    const eventId = new mongoose.Types.ObjectId();
    await CalendarEvent.create({
      _id: eventId,
      title: assignment.sourceEvent.title,
      type: assignment.sourceEvent.type,
      startAt: assignment.scheduledStartAt,
      endAt: assignment.scheduledEndAt,
      agencyId: assignment.sourceEvent.agencyId || null,
      consultantId: assignment.consultantId || null,
      notes: assignment.sourceEvent.notes || '',
      authorized: Boolean(assignment.sourceEvent.authorized),
      reminders: assignment.sourceEvent.reminders || { enabled: false, minutesBefore: [] },
      recurrenceSeriesId: assignment.sourceEvent.recurrenceSeriesId,
      recurrence: assignment.sourceEvent.recurrence,
      recalendarizationPeriod: period,
      createdBy: assignment.sourceEvent.createdBy,
      updatedBy: assignment.sourceEvent.updatedBy || assignment.sourceEvent.createdBy,
      createdAt: assignment.sourceEvent.createdAt,
    });
    return serializeResult(assignment, eventId);
  }

  const record = await getTargetInspection(assignment, period);
  if (record.visitStatus === 'completed') {
    return serializeResult({ ...assignment, reason: 'La visita del período ya está completada.' }, record.calendarEventId, 'already_scheduled');
  }
  if (record.calendarEventId) {
    const linkedEvent = await CalendarEvent.findById(record.calendarEventId).lean();
    if (linkedEvent) {
      return serializeResult({
        ...assignment,
        scheduledStartAt: linkedEvent.startAt,
        scheduledEndAt: linkedEvent.endAt,
        reason: '',
      }, linkedEvent._id, 'already_scheduled');
    }
    if (String(record.scheduleGenerationId || '') !== String(generation._id)) {
      return serializeResult({
        ...assignment,
        scheduledStartAt: null,
        scheduledEndAt: null,
        reason: 'El registro mensual ya contiene una referencia de visita.',
      }, record.calendarEventId, 'already_scheduled');
    }
    await AgencyMonthlyInspection.updateOne(
      {
        _id: record._id,
        calendarEventId: record.calendarEventId,
        scheduleGenerationId: generation._id,
      },
      {
        $set: {
          calendarEventId: null,
          visitStatus: 'pending',
          scheduleStatus: 'pending',
        },
      },
    );
    record.calendarEventId = null;
  }

  if (assignment.status === 'unscheduled') {
    await AgencyMonthlyInspection.updateOne(
      { _id: record._id, calendarEventId: null },
      {
        $set: {
          visitStatus: 'pending',
          scheduleStatus: 'unscheduled',
          scheduleReason: assignment.reason,
          scheduleGenerationId: generation._id,
        },
      },
    );
    return serializeResult(assignment);
  }

  const eventId = new mongoose.Types.ObjectId();
  const reserved = await AgencyMonthlyInspection.updateOne(
    { _id: record._id, calendarEventId: null, visitStatus: { $ne: 'completed' } },
    {
      $set: {
        calendarEventId: eventId,
        visitStatus: 'scheduled',
        scheduleStatus: 'scheduled',
        scheduleReason: '',
        scheduleGenerationId: generation._id,
        attendanceStatus: assignment.agency.auxiliaryConsultantId ? 'pending' : null,
        attendanceConfirmedBy: null,
        attendanceConfirmedAt: null,
      },
    },
  );
  if (!reserved.modifiedCount) {
    const latest = await AgencyMonthlyInspection.findById(record._id).lean();
    return serializeResult({
      ...assignment,
      scheduledStartAt: null,
      scheduledEndAt: null,
      reason: 'La visita ya fue programada por otra solicitud.',
    }, latest?.calendarEventId || null, 'already_scheduled');
  }

  try {
    await CalendarEvent.create({
      _id: eventId,
      title: assignment.sourceEvent.title || `Visita: ${assignment.agency.nombre}`,
      type: 'agency_visit',
      startAt: assignment.scheduledStartAt,
      endAt: assignment.scheduledEndAt,
      agencyId: assignment.agencyId,
      consultantId: assignment.consultantId,
      notes: assignment.sourceEvent.notes || '',
      authorized: record.authorizationStatus === 'authorized',
      reminders: assignment.sourceEvent.reminders || { enabled: false, minutesBefore: [] },
      recurrenceSeriesId: assignment.sourceEvent.recurrenceSeriesId || null,
      recurrence: assignment.sourceEvent.recurrence || null,
      recalendarizationPeriod: period,
      createdBy: assignment.sourceEvent.createdBy,
      updatedBy: assignment.sourceEvent.updatedBy || assignment.sourceEvent.createdBy,
      createdAt: assignment.sourceEvent.createdAt,
    });
  } catch (error) {
    await AgencyMonthlyInspection.updateOne(
      { _id: record._id, calendarEventId: eventId, scheduleGenerationId: generation._id },
      {
        $set: {
          calendarEventId: null,
          visitStatus: 'pending',
          scheduleStatus: 'pending',
        },
      },
    );
    throw error;
  }

  const latestRecord = await AgencyMonthlyInspection.findById(record._id).lean();
  if (latestRecord && latestRecord.authorizationStatus !== record.authorizationStatus) {
    await CalendarEvent.updateOne(
      { _id: eventId },
      { $set: { authorized: latestRecord.authorizationStatus === 'authorized' } },
    );
  }
  return serializeResult(assignment, eventId);
}

async function markGenerationFailed(generation, lockToken, error) {
  const message = error?.message || String(error);
  await MonthlyScheduleGeneration.updateOne(
    { _id: generation._id, lockToken, status: 'processing' },
    {
      $set: {
        status: 'failed',
        error: message.slice(0, 2000),
        completedAt: new Date(),
        lockExpiresAt: null,
      },
      $unset: { lockToken: 1 },
    },
  );
  logEvent('monthly_recalendarization_failed', {
    period: generation.period,
    message,
  });
}

async function generateMonthlyRecalendarization(period, now = new Date()) {
  getPeriodParts(period);
  await Promise.all([MonthlyScheduleGeneration.init(), CalendarEvent.init()]);
  const sourcePeriod = getPreviousPeriod(period);
  const previousGeneration = await MonthlyScheduleGeneration.findOne({ period })
    .select('status totalEvents sourceSnapshot')
    .lean();
  const entries = await loadSourceEntries(sourcePeriod, period);
  const sourceSnapshot = getSourceSnapshot(entries);
  if (previousGeneration?.status === 'completed'
    && previousGeneration.sourceSnapshot === sourceSnapshot) {
    return { generated: false, status: 'completed', period };
  }

  const { generation, lockToken } = await acquireMonthlyGeneration(
    period,
    sourcePeriod,
    sourceSnapshot,
    now,
  );
  if (!lockToken) {
    return {
      generated: false,
      status: generation.status,
      period,
    };
  }

  try {
    const targetRange = getPeriodRange(period);
    const existingEvents = await CalendarEvent.find({
      startAt: { $lt: targetRange.end },
      endAt: { $gt: targetRange.start },
    })
      .select('_id type startAt endAt consultantId agencyId recurrenceSeriesId recalendarizationPeriod')
      .lean();
    const targetEventsById = new Map(existingEvents.map((event) => [String(event._id), event]));
    const monthlySeriesIds = new Set(existingEvents
      .filter((event) => event.recurrenceSeriesId)
      .map((event) => String(event.recurrenceSeriesId)));
    const targetVisitAgencyIds = new Set(existingEvents
      .filter((event) => event.type === 'agency_visit' && event.agencyId)
      .map((event) => String(event.agencyId)));
    const candidates = [];
    const results = [];

    for (const entry of entries) {
      if (entry.kind === 'calendar_event') {
        const seriesId = String(entry.sourceEvent.recurrenceSeriesId);
        if (monthlySeriesIds.has(seriesId)) {
          const existing = existingEvents.find((event) => String(event.recurrenceSeriesId) === seriesId);
          results.push(serializeResult({
            ...entry,
            idealStartAt: getPreferredStartAt(entry.sourceEvent, period),
            scheduledStartAt: existing?.startAt || null,
            scheduledEndAt: existing?.endAt || null,
            reason: '',
          }, existing?._id || null, 'already_scheduled'));
          continue;
        }
      } else {
        const monthlyRecord = await AgencyMonthlyInspection.findOne({
          agencyId: entry.agencyId,
          period,
        }).lean();
        if (monthlyRecord?.calendarEventId && targetEventsById.has(String(monthlyRecord.calendarEventId))) {
          const event = targetEventsById.get(String(monthlyRecord.calendarEventId));
          results.push(serializeResult({
            ...entry,
            idealStartAt: getPreferredStartAt(entry.sourceEvent, period),
            scheduledStartAt: event.startAt,
            scheduledEndAt: event.endAt,
            reason: '',
          }, event._id, 'already_scheduled'));
          continue;
        }
        if (targetVisitAgencyIds.has(String(entry.agencyId))) {
          results.push(serializeResult({
            ...entry,
            idealStartAt: getPreferredStartAt(entry.sourceEvent, period),
            scheduledStartAt: null,
            scheduledEndAt: null,
            reason: 'Ya existe una visita para esta agencia en el período.',
          }, null, 'already_scheduled'));
          continue;
        }
      }
      candidates.push(entry);
    }

    const assignments = buildMonthlySchedule(candidates, period, existingEvents);
    for (const assignment of assignments) {
      const result = await persistAssignment(assignment, period, generation);
      results.push(result);
      if (result.targetEventId) {
        const event = assignment.status === 'unscheduled'
          ? null
          : {
            _id: result.targetEventId,
            type: assignment.sourceEvent.type,
            startAt: assignment.scheduledStartAt,
            endAt: assignment.scheduledEndAt,
            consultantId: assignment.consultantId,
            agencyId: assignment.agencyId,
          };
        if (event) targetEventsById.set(String(event._id), event);
      }
    }

    const counts = countResults(results);
    const completed = await MonthlyScheduleGeneration.updateOne(
      { _id: generation._id, lockToken, status: 'processing' },
      {
        $set: {
          ...counts,
          results,
          status: 'completed',
          completedAt: new Date(),
          error: '',
          lockExpiresAt: null,
        },
        $unset: { lockToken: 1 },
      },
    );
    if (!completed.modifiedCount) {
      throw new Error(`Monthly generation lock was lost for ${period}.`);
    }
    logEvent('monthly_recalendarization_completed', { period, sourcePeriod, ...counts });
    return { generated: true, period, sourcePeriod, ...counts };
  } catch (error) {
    await markGenerationFailed(generation, lockToken, error);
    throw error;
  }
}

function ensureMonthlyRecalendarization(period, now = new Date()) {
  getPeriodParts(period);
  if (!isAutomaticTargetPeriod(period, now)) {
    return Promise.resolve({ generated: false, status: 'outside_generation_window', period });
  }
  const pending = inFlightGenerations.get(period);
  if (pending) return pending;

  const generation = generateMonthlyRecalendarization(period, now)
    .finally(() => {
      if (inFlightGenerations.get(period) === generation) inFlightGenerations.delete(period);
    });
  inFlightGenerations.set(period, generation);
  return generation;
}

module.exports = {
  GENERATION_LOCK_MS,
  MINIMUM_GAP_MINUTES,
  TIME_ZONE,
  acquireMonthlyGeneration,
  buildMonthlySchedule,
  ensureMonthlyRecalendarization,
  findNextAvailableSlot,
  getIdealDate,
  getLocalParts,
  getNextMonthBoundary,
  getPeriodForDate,
  getPeriodForRange,
  getPeriodRange,
  getPreviousPeriod,
  getWorkingHours,
  generateMonthlyRecalendarization,
  getSourceSnapshot,
  isAutomaticTargetPeriod,
  isFederalHoliday,
  isValidSlot,
  localDateTimeToUtc,
};
