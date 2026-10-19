'use strict';

const mongoose = require('mongoose');
const CalendarEvent = require('../models/CalendarEvent');
const Agency = require('../models/Agency');
const User = require('../models/User');
const { success } = require('../utils/response');
const { recordAgencyHistory } = require('../services/agencyHistory');

const EVENT_TYPES = new Set([
  'agency_visit',
  'document_deadline',
  'file_review',
  'personal_admin',
  'impuestos_verdes',
]);
const EVENT_FIELDS = new Set([
  'title', 'type', 'startAt', 'endAt', 'agencyId', 'consultantId',
  'notes', 'authorized', 'status', 'reminders',
]);
const RECURRENCE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const MAX_SERIES_OCCURRENCES = 500;
const POPULATES = [
  { path: 'agencyId', select: 'nombre' },
  { path: 'consultantId', select: 'nombre correo rol' },
];
const isAdmin = (user) => ['admin', 'developer'].includes(user.rol);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validationFailure(res, errors) {
  return res.status(400).json({ success: false, message: 'Validation failed', errors });
}

function parseDate(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateEventInput(body, partial) {
  const errors = {};
  const value = {};
  if (!isObject(body)) return { errors: { body: 'A JSON object is required' }, value };

  for (const key of Object.keys(body)) {
    if (!EVENT_FIELDS.has(key)) errors[key] = 'Unknown field';
  }

  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) errors.title = 'A title is required';
    else if (body.title.trim().length > 160) errors.title = 'Must not exceed 160 characters';
    else value.title = body.title.trim();
  }
  if (!partial || body.type !== undefined) {
    if (!EVENT_TYPES.has(body.type)) errors.type = `Must be one of: ${[...EVENT_TYPES].join(', ')}`;
    else value.type = body.type;
  }

  for (const field of ['startAt', 'endAt']) {
    if (!partial || body[field] !== undefined) {
      const parsed = parseDate(body[field]);
      if (!parsed) errors[field] = 'Must be an ISO 8601 date-time with timezone';
      else value[field] = parsed;
    }
  }
  if (value.startAt && value.endAt && value.endAt <= value.startAt) {
    errors.endAt = 'Must be later than startAt';
  }

  for (const field of ['agencyId', 'consultantId']) {
    if (body[field] === undefined) continue;
    if (body[field] === null || body[field] === '') value[field] = null;
    else if (!mongoose.isValidObjectId(body[field])) errors[field] = 'Must be a valid ID or null';
    else value[field] = body[field];
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string') errors.notes = 'Must be a string';
    else if (body.notes.trim().length > 4000) errors.notes = 'Must not exceed 4000 characters';
    else value.notes = body.notes.trim();
  }

  if (body.authorized !== undefined && typeof body.authorized !== 'boolean') {
    errors.authorized = 'Must be true or false';
  } else if (body.authorized !== undefined) value.authorized = body.authorized;
  if (body.status !== undefined) {
    if (!['pending', 'authorized'].includes(body.status)) {
      errors.status = 'Must be pending or authorized';
    } else if (body.authorized !== undefined && body.authorized !== (body.status === 'authorized')) {
      errors.status = 'Must match authorized';
    } else {
      value.authorized = body.status === 'authorized';
    }
  }
  if (body.reminders !== undefined) {
    const reminders = body.reminders;
    if (!isObject(reminders)) errors.reminders = 'Must be an object';
    else {
      const reminderErrors = {};
      if (reminders.enabled !== undefined && typeof reminders.enabled !== 'boolean') {
        reminderErrors.enabled = 'Must be true or false';
      }
      if (reminders.minutesBefore !== undefined) {
        const offsets = reminders.minutesBefore;
        if (!Array.isArray(offsets) || offsets.length > 5
          || offsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset > 525600)
          || new Set(offsets).size !== offsets.length) {
          reminderErrors.minutesBefore = 'Must contain at most five unique integers from 0 to 525600';
        }
      }
      if (Object.keys(reminderErrors).length) errors.reminders = reminderErrors;
      else value.reminders = reminders;
    }
  }
  return { errors, value };
}

function serializeEvent(event) {
  const agency = event.agencyId && typeof event.agencyId === 'object' ? event.agencyId : null;
  const consultant = event.consultantId && typeof event.consultantId === 'object'
    ? event.consultantId
    : null;
  const authorized = Boolean(event.authorized);
  return {
    id: String(event._id),
    title: event.title,
    type: event.type,
    startAt: event.startAt,
    endAt: event.endAt,
    agencyId: agency ? String(agency._id) : event.agencyId ? String(event.agencyId) : null,
    agencyName: agency?.nombre || null,
    consultantId: consultant
      ? String(consultant._id)
      : event.consultantId ? String(event.consultantId) : null,
    consultant: consultant ? {
      id: String(consultant._id),
      name: consultant.nombre,
      email: consultant.correo,
      role: consultant.rol,
    } : null,
    notes: event.notes || '',
    authorized,
    status: authorized ? 'authorized' : 'pending',
    reminders: event.reminders || { enabled: false, minutesBefore: [] },
    recurrenceSeriesId: event.recurrenceSeriesId ? String(event.recurrenceSeriesId) : null,
    recurrence: event.recurrence || null,
    createdBy: String(event.createdBy),
    updatedBy: String(event.updatedBy),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function validId(value) {
  return mongoose.isValidObjectId(value);
}

function validateEventSeriesInput(body) {
  const errors = {};
  if (!isObject(body)) return { errors: { body: 'A JSON object is required' } };
  for (const key of Object.keys(body)) {
    if (!['event', 'recurrence', 'occurrences'].includes(key)) errors[key] = 'Unknown field';
  }

  const baseResult = validateEventInput(body.event, false);
  if (Object.keys(baseResult.errors).length) errors.event = baseResult.errors;

  const recurrence = body.recurrence;
  if (!isObject(recurrence)) {
    errors.recurrence = 'A recurrence rule is required';
  } else {
    for (const key of Object.keys(recurrence)) {
      if (!['frequency', 'interval', 'daysOfWeek', 'endDate'].includes(key)) {
        errors[`recurrence.${key}`] = 'Unknown field';
      }
    }
    if (!RECURRENCE_FREQUENCIES.has(recurrence.frequency)) {
      errors['recurrence.frequency'] = `Must be one of: ${[...RECURRENCE_FREQUENCIES].join(', ')}`;
    }
    if (!Number.isInteger(recurrence.interval) || recurrence.interval < 1 || recurrence.interval > 365) {
      errors['recurrence.interval'] = 'Must be an integer from 1 to 365';
    }
    const endDate = typeof recurrence.endDate === 'string'
      ? new Date(`${recurrence.endDate}T00:00:00Z`)
      : null;
    if (typeof recurrence.endDate !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(recurrence.endDate)
      || Number.isNaN(endDate?.getTime())
      || endDate.toISOString().slice(0, 10) !== recurrence.endDate) {
      errors['recurrence.endDate'] = 'Must be a valid date in YYYY-MM-DD format';
    }
    const days = recurrence.daysOfWeek;
    if (recurrence.frequency === 'weekly') {
      if (!Array.isArray(days) || !days.length || days.length > 7
        || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
        || new Set(days).size !== days.length) {
        errors['recurrence.daysOfWeek'] = 'Must contain one to seven unique weekdays from 0 to 6';
      }
    } else if (days !== undefined && (!Array.isArray(days) || days.length)) {
      errors['recurrence.daysOfWeek'] = 'Weekdays can only be selected for weekly recurrence';
    }
  }

  const occurrences = body.occurrences;
  if (!Array.isArray(occurrences) || occurrences.length < 2
    || occurrences.length > MAX_SERIES_OCCURRENCES) {
    errors.occurrences = `Must contain between 2 and ${MAX_SERIES_OCCURRENCES} occurrences`;
  } else {
    let previousStart = null;
    let duration = null;
    const starts = new Set();
    occurrences.forEach((occurrence, index) => {
      const field = `occurrences.${index}`;
      if (!isObject(occurrence) || Object.keys(occurrence).some((key) => !['startAt', 'endAt'].includes(key))) {
        errors[field] = 'Must contain only startAt and endAt';
        return;
      }
      const startAt = parseDate(occurrence.startAt);
      const endAt = parseDate(occurrence.endAt);
      if (!startAt) errors[`${field}.startAt`] = 'Must be an ISO 8601 date-time with timezone';
      if (!endAt) errors[`${field}.endAt`] = 'Must be an ISO 8601 date-time with timezone';
      if (!startAt || !endAt) return;
      if (endAt <= startAt) errors[`${field}.endAt`] = 'Must be later than startAt';
      if (starts.has(startAt.getTime()) || (previousStart && startAt <= previousStart)) {
        errors[field] = 'Occurrences must have unique, increasing start times';
      }
      starts.add(startAt.getTime());
      previousStart = startAt;
      const currentDuration = endAt.getTime() - startAt.getTime();
      if (duration !== null && duration !== currentDuration) {
        errors[field] = 'All occurrences must have the same duration';
      }
      duration = currentDuration;
    });
    if (!baseResult.errors.startAt && occurrences.length
      && parseDate(occurrences[0]?.startAt)?.getTime() !== baseResult.value.startAt?.getTime()) {
      errors.occurrences = 'The first occurrence must match the activity start time';
    }
    if (!baseResult.errors.startAt && !baseResult.errors.endAt && occurrences.length
      && (parseDate(occurrences[0]?.endAt)?.getTime() - parseDate(occurrences[0]?.startAt)?.getTime())
        !== (baseResult.value.endAt.getTime() - baseResult.value.startAt.getTime())) {
      errors.occurrences = 'Occurrences must use the activity duration';
    }
  }

  return {
    errors,
    value: {
      event: baseResult.value,
      recurrence,
      occurrences,
    },
  };
}

function eventAgencyId(event) {
  const value = event.agencyId?._id || event.agencyId;
  return value ? String(value) : null;
}

async function getCalendarEvents(req, res, next) {
  const rangeStart = parseDate(req.query.rangeStart);
  const rangeEnd = parseDate(req.query.rangeEnd);
  if (!rangeStart || !rangeEnd || rangeEnd <= rangeStart) {
    return validationFailure(res, {
      rangeStart: 'A valid rangeStart ISO date-time is required',
      rangeEnd: 'A valid rangeEnd later than rangeStart is required',
    });
  }
  if (req.query.view !== undefined
    && (typeof req.query.view !== 'string' || req.query.view.length > 40)) {
    return validationFailure(res, { view: 'Must be a string of at most 40 characters' });
  }
  const filter = {
    startAt: { $lt: rangeEnd },
    endAt: { $gt: rangeStart },
    ...(isAdmin(req.user) ? {} : { authorized: true }),
  };
  if (req.user.rol === 'consultor') {
    const assignedAgencyIds = await Agency.find({ consultantId: req.user._id }).distinct('_id');
    filter.agencyId = { $in: assignedAgencyIds };
  }
  if (req.query.agencyId !== undefined) {
    if (!validId(req.query.agencyId)) return validationFailure(res, { agencyId: 'Must be a valid ID' });
    if (req.user.rol === 'consultor' && !filter.agencyId.$in.some((id) => String(id) === req.query.agencyId)) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    filter.agencyId = req.query.agencyId;
  }
  if (req.query.consultantId !== undefined) {
    if (req.query.consultantId === 'me') filter.consultantId = req.user._id;
    else if (!validId(req.query.consultantId)) {
      return validationFailure(res, { consultantId: 'Must be a valid ID or "me"' });
    } else filter.consultantId = req.query.consultantId;
  }
  if (req.query.view === 'mine') filter.consultantId = req.user._id;
  if (req.query.authorized !== undefined) {
    if (!isAdmin(req.user) && req.query.authorized !== 'true') {
      return res.status(403).json({ success: false, message: 'Only administrators can view unauthorized events.' });
    }
    if (!['true', 'false'].includes(req.query.authorized)) {
      return validationFailure(res, { authorized: 'Must be true or false' });
    }
    filter.authorized = req.query.authorized === 'true';
  }

  try {
    const events = await CalendarEvent.find(filter)
      .populate(POPULATES)
      .sort({ startAt: 1 })
      .lean();
    return success(res, { events: events.map(serializeEvent) }, 'Calendar events fetched');
  } catch (error) {
    return next(error);
  }
}

async function getCalendarConsultants(req, res, next) {
  try {
    if (req.user.rol === 'consultor') {
      return success(res, {
        consultants: [{
          id: String(req.user._id),
          name: req.user.nombre,
          email: req.user.correo,
          role: req.user.rol,
        }],
      }, 'Calendar consultants fetched');
    }
    const consultants = await User.find({ rol: { $in: ['consultor', 'user'] }, status: 'activo' })
      .select('nombre correo rol')
      .sort({ nombre: 1 })
      .lean();
    return success(res, {
      consultants: consultants.map((user) => ({
        id: String(user._id),
        name: user.nombre,
        email: user.correo,
        role: user.rol,
      })),
    }, 'Calendar consultants fetched');
  } catch (error) {
    return next(error);
  }
}

async function validateRelations(value, res) {
  if (value.agencyId && !await Agency.exists({ _id: value.agencyId })) {
    validationFailure(res, { agencyId: 'Agency not found' });
    return false;
  }
  if (value.consultantId) {
    const user = await User.findOne({
      _id: value.consultantId,
      rol: { $in: ['consultor', 'user'] },
      status: 'activo',
    }).select('_id');
    if (!user) {
      validationFailure(res, { consultantId: 'Active consultant/user not found' });
      return false;
    }
  }
  return true;
}

function validatePathId(id, res) {
  if (validId(id)) return true;
  res.status(400).json({ success: false, message: 'Invalid calendar event ID' });
  return false;
}

async function createCalendarEvent(req, res, next) {
  const { errors, value } = validateEventInput(req.body, false);
  if (Object.keys(errors).length) return validationFailure(res, errors);
  try {
    if (!await validateRelations(value, res)) return;
    const event = await CalendarEvent.create({
      ...value,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await event.populate(POPULATES);
    if (event.agencyId) {
      await recordAgencyHistory({
        agencyId: event.agencyId,
        actor: req.user,
        action: 'calendar_event_created',
        summary: `Se programó una actividad: ${event.title}`,
        details: { eventId: String(event._id), type: event.type, startAt: event.startAt, endAt: event.endAt },
      });
    }
    return success(res, serializeEvent(event), 'Calendar event created', 201);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return validationFailure(res, Object.fromEntries(
        Object.entries(error.errors).map(([field, detail]) => [field, detail.message]),
      ));
    }
    return next(error);
  }
}

async function createCalendarEventSeries(req, res, next) {
  const { errors, value } = validateEventSeriesInput(req.body);
  if (Object.keys(errors).length) return validationFailure(res, errors);
  try {
    if (!await validateRelations(value.event, res)) return;
    const recurrenceSeriesId = new mongoose.Types.ObjectId();
    const recurrence = {
      frequency: value.recurrence.frequency,
      interval: value.recurrence.interval,
      daysOfWeek: value.recurrence.frequency === 'weekly' ? value.recurrence.daysOfWeek : [],
      endDate: value.recurrence.endDate,
    };
    const documents = value.occurrences.map((occurrence) => new CalendarEvent({
      ...value.event,
      startAt: parseDate(occurrence.startAt),
      endAt: parseDate(occurrence.endAt),
      recurrenceSeriesId,
      recurrence,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    }));
    await Promise.all(documents.map((event) => event.validate()));
    const createdEvents = await CalendarEvent.insertMany(documents, { ordered: true });
    if (value.event.agencyId) {
      const ruleLabel = recurrence.frequency === 'daily'
        ? `${recurrence.interval} día(s)`
        : recurrence.frequency === 'weekly'
          ? `${recurrence.interval} semana(s)`
          : `${recurrence.interval} mes(es)`;
      await recordAgencyHistory({
        agencyId: value.event.agencyId,
        actor: req.user,
        action: 'calendar_event_series_created',
        summary: `Se programó una serie de ${createdEvents.length} actividades: ${value.event.title}`,
        details: { recurrenceSeriesId: String(recurrenceSeriesId), frequency: ruleLabel, endDate: recurrence.endDate },
      });
    }
    return success(res, {
      recurrenceSeriesId: String(recurrenceSeriesId),
      count: createdEvents.length,
      firstStartAt: createdEvents[0]?.startAt || null,
      lastStartAt: createdEvents.at(-1)?.startAt || null,
    }, 'Calendar event series created', 201);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return validationFailure(res, Object.fromEntries(
        Object.entries(error.errors).map(([field, detail]) => [field, detail.message]),
      ));
    }
    return next(error);
  }
}

async function updateCalendarEvent(req, res, next) {
  if (!validatePathId(req.params.id, res)) return;
  const { errors, value } = validateEventInput(req.body, true);
  if (Object.keys(errors).length) return validationFailure(res, errors);
  if (!Object.keys(value).length) return validationFailure(res, { body: 'At least one field is required' });
  try {
    const event = await CalendarEvent.findById(req.params.id);
    if (!event) return res.status(404).json({ success: false, message: 'Calendar event not found' });
    if (value.startAt === undefined && value.endAt !== undefined) value.startAt = event.startAt;
    if (value.endAt === undefined && value.startAt !== undefined) value.endAt = event.endAt;
    if (value.endAt && value.startAt && value.endAt <= value.startAt) {
      return validationFailure(res, { endAt: 'Must be later than startAt' });
    }
    if (!await validateRelations(value, res)) return;
    const previousAgencyId = eventAgencyId(event);
    const previousTitle = event.title;
    Object.assign(event, value, { updatedBy: req.user._id });
    await event.save();
    await event.populate(POPULATES);
    const nextAgencyId = eventAgencyId(event);
    const historyAgencyIds = [...new Set([previousAgencyId, nextAgencyId].filter(Boolean))];
    await Promise.all(historyAgencyIds.map((agencyId) => recordAgencyHistory({
      agencyId,
      actor: req.user,
      action: 'calendar_event_updated',
      summary: `Se actualizó una actividad: ${event.title || previousTitle}`,
      details: { eventId: String(event._id), type: event.type, agencyChanged: previousAgencyId !== nextAgencyId },
    })));
    return success(res, serializeEvent(event), 'Calendar event updated');
  } catch (error) {
    if (error.name === 'ValidationError') {
      return validationFailure(res, Object.fromEntries(
        Object.entries(error.errors).map(([field, detail]) => [field, detail.message]),
      ));
    }
    return next(error);
  }
}

async function deleteCalendarEvent(req, res, next) {
  if (!validatePathId(req.params.id, res)) return;
  try {
    const event = await CalendarEvent.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ success: false, message: 'Calendar event not found' });
    if (event.agencyId) {
      await recordAgencyHistory({
        agencyId: event.agencyId,
        actor: req.user,
        action: 'calendar_event_deleted',
        summary: `Se eliminó una actividad: ${event.title}`,
        details: { eventId: String(event._id), type: event.type, startAt: event.startAt, endAt: event.endAt },
      });
    }
    return success(res, { id: String(event._id) }, 'Calendar event deleted');
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createCalendarEvent,
  createCalendarEventSeries,
  deleteCalendarEvent,
  getCalendarConsultants,
  getCalendarEvents,
  serializeEvent,
  validateEventSeriesInput,
  updateCalendarEvent,
  validateEventInput,
};
