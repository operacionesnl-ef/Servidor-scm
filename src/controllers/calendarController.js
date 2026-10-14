'use strict';

const mongoose = require('mongoose');
const CalendarEvent = require('../models/CalendarEvent');
const Agency = require('../models/Agency');
const User = require('../models/User');
const { success } = require('../utils/response');

const EVENT_TYPES = new Set([
  'agency_visit',
  'document_deadline',
  'file_review',
  'personal_admin',
]);
const EVENT_FIELDS = new Set([
  'title', 'type', 'startAt', 'endAt', 'agencyId', 'consultantId',
  'notes', 'authorized', 'status', 'reminders',
]);
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
    createdBy: String(event.createdBy),
    updatedBy: String(event.updatedBy),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function validId(value) {
  return mongoose.isValidObjectId(value);
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
  if (req.query.agencyId !== undefined) {
    if (!validId(req.query.agencyId)) return validationFailure(res, { agencyId: 'Must be a valid ID' });
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
    Object.assign(event, value, { updatedBy: req.user._id });
    await event.save();
    await event.populate(POPULATES);
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
    return success(res, { id: String(event._id) }, 'Calendar event deleted');
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarConsultants,
  getCalendarEvents,
  serializeEvent,
  updateCalendarEvent,
  validateEventInput,
};
