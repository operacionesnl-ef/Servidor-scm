'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const CalendarEvent = require('../models/CalendarEvent');
const { success } = require('../utils/response');

const AUTHORIZATION_STATUSES = new Set(['pending', 'authorized', 'unauthorized']);

function validationFailure(res, errors) {
  return res.status(400).json({ success: false, message: 'Validation failed', errors });
}

function validAgencyId(id, res) {
  if (mongoose.isValidObjectId(id)) return true;
  res.status(400).json({ success: false, message: 'Invalid agency ID' });
  return false;
}

function validPeriod(period, res) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) return true;
  validationFailure(res, { period: 'Must use YYYY-MM format' });
  return false;
}

function parseDate(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function serializeRecord(record) {
  return {
    id: String(record._id),
    agencyId: String(record.agencyId),
    period: record.period,
    authorizationStatus: record.authorizationStatus,
    visitStatus: record.visitStatus,
    calendarEventId: record.calendarEventId ? String(record.calendarEventId) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function findAgencyOr404(agencyId, res) {
  const agency = await Agency.findById(agencyId).select('_id nombre consultantId status');
  if (!agency) {
    res.status(404).json({ success: false, message: 'Agency not found' });
    return null;
  }
  return agency;
}

async function getMonthlyInspection(req, res, next) {
  if (!validAgencyId(req.params.id, res) || !validPeriod(req.params.period, res)) return;
  try {
    if (!await findAgencyOr404(req.params.id, res)) return;
    const record = await AgencyMonthlyInspection.findOne({
      agencyId: req.params.id,
      period: req.params.period,
    }).lean();
    return success(res, { record: record ? serializeRecord(record) : null }, 'Monthly inspection fetched');
  } catch (error) {
    return next(error);
  }
}

async function updateMonthlyAuthorization(req, res, next) {
  if (!validAgencyId(req.params.id, res) || !validPeriod(req.params.period, res)) return;
  const { authorizationStatus } = req.body || {};
  if (Object.keys(req.body || {}).some((field) => field !== 'authorizationStatus')) {
    return validationFailure(res, { body: 'Only authorizationStatus is allowed' });
  }
  if (!AUTHORIZATION_STATUSES.has(authorizationStatus)) {
    return validationFailure(res, {
      authorizationStatus: `Must be one of: ${[...AUTHORIZATION_STATUSES].join(', ')}`,
    });
  }
  try {
    if (!await findAgencyOr404(req.params.id, res)) return;
    const record = await AgencyMonthlyInspection.findOneAndUpdate(
      { agencyId: req.params.id, period: req.params.period },
      { $set: { authorizationStatus }, $setOnInsert: { visitStatus: 'scheduled' } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    return success(res, serializeRecord(record), 'Monthly authorization updated');
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Monthly inspection already exists; retry the update.' });
    }
    return next(error);
  }
}

function validateVisitBody(body) {
  const errors = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { body: 'A JSON object is required' } };
  }
  for (const field of Object.keys(body)) {
    if (!['startAt', 'endAt', 'notes', 'reminders'].includes(field)) errors[field] = 'Unknown field';
  }
  const startAt = parseDate(body.startAt);
  const endAt = parseDate(body.endAt);
  if (!startAt) errors.startAt = 'Must be an ISO 8601 date-time with timezone';
  if (!endAt) errors.endAt = 'Must be an ISO 8601 date-time with timezone';
  if (startAt && endAt && endAt <= startAt) errors.endAt = 'Must be later than startAt';
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.trim().length > 4000)) {
    errors.notes = 'Must be a string of at most 4000 characters';
  }
  if (body.reminders !== undefined) {
    const reminders = body.reminders;
    if (!reminders || typeof reminders !== 'object' || Array.isArray(reminders)) {
      errors.reminders = 'Must be an object';
    } else {
      for (const key of Object.keys(reminders)) {
        if (!['enabled', 'minutesBefore'].includes(key)) errors[`reminders.${key}`] = 'Unknown field';
      }
      const offsets = reminders.minutesBefore;
      if (reminders.enabled !== undefined && typeof reminders.enabled !== 'boolean') {
        errors['reminders.enabled'] = 'Must be true or false';
      }
      if (offsets !== undefined && (!Array.isArray(offsets) || offsets.length > 5
        || offsets.some((minutes) => !Number.isInteger(minutes) || minutes < 0 || minutes > 525600)
        || new Set(offsets).size !== offsets.length)) {
        errors['reminders.minutesBefore'] = 'Must contain at most five unique integers from 0 to 525600';
      }
    }
  }
  return { errors, value: { startAt, endAt } };
}

async function scheduleMonthlyVisit(req, res, next) {
  if (!validAgencyId(req.params.id, res) || !validPeriod(req.params.period, res)) return;
  const { errors, value } = validateVisitBody(req.body);
  if (Object.keys(errors).length) return validationFailure(res, errors);
  try {
    const agency = await findAgencyOr404(req.params.id, res);
    if (!agency) return;
    if (!agency.consultantId) {
      return validationFailure(res, { consultantId: 'Agency has no responsible consultant assigned' });
    }
    await AgencyMonthlyInspection.updateOne(
      { agencyId: agency._id, period: req.params.period },
      { $setOnInsert: { authorizationStatus: 'pending', visitStatus: 'scheduled' } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    const record = await AgencyMonthlyInspection.findOne({
      agencyId: agency._id,
      period: req.params.period,
    });
    let eventId = record.calendarEventId;
    if (!eventId) {
      eventId = new mongoose.Types.ObjectId();
      const reserved = await AgencyMonthlyInspection.updateOne(
        { _id: record._id, calendarEventId: null, visitStatus: { $ne: 'completed' } },
        { $set: { calendarEventId: eventId } },
      );
      if (!reserved.modifiedCount) {
        const latest = await AgencyMonthlyInspection.findById(record._id).lean();
        if (!latest?.calendarEventId) {
          return res.status(409).json({ success: false, message: 'Monthly visit is already being scheduled.' });
        }
        eventId = latest.calendarEventId;
      }
    }
    if (await CalendarEvent.exists({ _id: eventId })) {
      return res.status(409).json({ success: false, message: 'A calendar visit is already linked to this period.' });
    }

    const event = await CalendarEvent.create({
      _id: eventId,
      title: `Visita: ${agency.nombre}`,
      type: 'agency_visit',
      startAt: value.startAt,
      endAt: value.endAt,
      agencyId: agency._id,
      consultantId: agency.consultantId,
      notes: req.body.notes?.trim() || '',
      authorized: true,
      reminders: req.body.reminders || { enabled: false, minutesBefore: [] },
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    return success(res, {
      record: serializeRecord(await AgencyMonthlyInspection.findById(record._id).lean()),
      calendarEvent: {
        id: String(event._id),
        title: event.title,
        type: event.type,
        startAt: event.startAt,
        endAt: event.endAt,
        agencyId: String(event.agencyId),
        consultantId: String(event.consultantId),
      },
    }, 'Monthly visit scheduled', 201);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'A calendar visit is already linked to this period.' });
    }
    if (error.name === 'ValidationError') {
      return validationFailure(res, Object.fromEntries(
        Object.entries(error.errors).map(([field, detail]) => [field, detail.message]),
      ));
    }
    return next(error);
  }
}

async function updateMonthlyVisitStatus(req, res, next) {
  if (!validAgencyId(req.params.id, res) || !validPeriod(req.params.period, res)) return;
  if (Object.keys(req.body || {}).some((field) => field !== 'status')
    || req.body?.status !== 'completed') {
    return validationFailure(res, { status: 'Must be completed; create a calendar visit to schedule it' });
  }
  try {
    const record = await AgencyMonthlyInspection.findOne({
      agencyId: req.params.id,
      period: req.params.period,
    });
    if (!record) return res.status(404).json({ success: false, message: 'Monthly inspection not found' });
    if (!record.calendarEventId || !await CalendarEvent.exists({ _id: record.calendarEventId })) {
      return validationFailure(res, { status: 'A linked calendar visit is required before completion' });
    }
    record.visitStatus = 'completed';
    await record.save();
    return success(res, serializeRecord(record), 'Monthly visit marked completed');
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMonthlyInspection,
  scheduleMonthlyVisit,
  updateMonthlyAuthorization,
  updateMonthlyVisitStatus,
  validateVisitBody,
};
