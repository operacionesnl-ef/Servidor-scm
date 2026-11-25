'use strict';

const mongoose = require('mongoose');
const CalendarEvent = require('../models/CalendarEvent');
const Agency = require('../models/Agency');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const User = require('../models/User');
const { success } = require('../utils/response');
const { recordAgencyHistory } = require('../services/agencyHistory');
const { notifyConsultant } = require('../services/consultantNotifications');
const {
  ensureMonthlyRecalendarization,
  getPeriodForRange,
} = require('../services/monthlyRecalendarization');
const {
  formatSuggestedStartAt,
  validateCalendarSlots,
} = require('../services/calendarAvailability');
const { getAgencyConsultantFilter, getAgencyConsultants } = require('../utils/agencyConsultants');

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
  {
    path: 'agencyId',
    select: 'nombre consultantId auxiliaryConsultantId',
    populate: [
      { path: 'consultantId', select: 'nombre correo rol' },
      { path: 'auxiliaryConsultantId', select: 'nombre correo rol' },
    ],
  },
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
  const consultantIds = [...new Set([
    ...getAgencyConsultants(agency).map(({ id }) => id),
    consultant
      ? String(consultant._id)
      : event.consultantId ? String(event.consultantId) : '',
  ].filter(Boolean))];
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
    consultantIds,
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

async function getVisitConsultant(event) {
  if (!event?.agencyId || event.type !== 'agency_visit') return null;
  const agency = await Agency.findById(event.agencyId)
    .select('_id nombre consultantId auxiliaryConsultantId')
    .lean();
  if (!agency?.consultantId) return null;
  return {
    consultants: getAgencyConsultants(agency),
    agencyId: agency._id,
    agencyName: agency.nombre,
    actionUrl: `/agencias/${agency._id}?tab=inspections`,
  };
}

async function notifyVisitChange(event, notification, idempotencySuffix) {
  try {
    const recipient = await getVisitConsultant(event);
    if (!recipient) return;
    const inspection = await AgencyMonthlyInspection.findOne({ calendarEventId: event._id })
      .select('attendanceStatus')
      .lean();
    const date = event.startAt instanceof Date ? event.startAt : new Date(event.startAt);
    const dateLabel = Number.isNaN(date.getTime())
      ? 'fecha no disponible'
      : date.toLocaleString('es-MX', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'America/Mexico_City',
      });
    const messages = {
      scheduled: {
        title: 'Visita programada',
        message: `Tu visita a ${recipient.agencyName} está programada para el ${dateLabel}.`,
        type: 'visit_scheduled',
        auxiliaryTitle: inspection
          ? 'Visita programada · Confirmación pendiente'
          : 'Visita programada · Auxiliar',
        auxiliaryMessage: inspection
          ? `La visita a ${recipient.agencyName} está programada para el ${dateLabel}. Confirma en Inspecciones si asistirás tú o el consultor principal.`
          : `La visita a ${recipient.agencyName} está programada para el ${dateLabel}.`,
        auxiliaryType: inspection ? 'visit_attendance_confirmation' : 'visit_scheduled_auxiliary',
      },
      authorized: {
        title: 'Visita autorizada',
        message: `Se autorizó tu visita a ${recipient.agencyName} para el ${dateLabel}.`,
        type: 'visit_authorized',
        auxiliaryTitle: 'Visita autorizada · Auxiliar',
        auxiliaryMessage: `Se autorizó la visita a ${recipient.agencyName} para el ${dateLabel}. Al programarse, recibirás una solicitud para confirmar quién asistirá.`,
        auxiliaryType: 'visit_authorized_auxiliary',
      },
      changed: {
        title: 'Cambio de visita',
        message: `La visita a ${recipient.agencyName} cambió. Nueva fecha: ${dateLabel}.`,
        type: 'visit_changed',
        auxiliaryTitle: inspection
          ? 'Cambio de visita · Confirmación pendiente'
          : 'Cambio de visita · Auxiliar',
        auxiliaryMessage: inspection
          ? `La visita a ${recipient.agencyName} cambió y está programada para el ${dateLabel}. Confirma en Inspecciones si asistirás tú o el consultor principal.`
          : `La visita a ${recipient.agencyName} cambió. Nueva fecha: ${dateLabel}.`,
        auxiliaryType: inspection ? 'visit_attendance_confirmation' : 'visit_changed_auxiliary',
      },
      cancelled: {
        title: 'Visita cancelada',
        message: `La visita a ${recipient.agencyName} del ${dateLabel} fue cancelada.`,
        type: 'visit_cancelled',
        auxiliaryTitle: 'Visita cancelada · Auxiliar',
        auxiliaryMessage: `La visita a ${recipient.agencyName} del ${dateLabel} fue cancelada.`,
        auxiliaryType: 'visit_cancelled_auxiliary',
      },
    };
    const content = messages[notification];
    await Promise.all(recipient.consultants.map(({ id, role }) => {
      const auxiliary = role === 'auxiliary';
      return notifyConsultant({
        consultantId: id,
        agencyId: recipient.agencyId,
        actionUrl: recipient.actionUrl,
        title: auxiliary ? content.auxiliaryTitle : content.title,
        message: auxiliary ? content.auxiliaryMessage : content.message,
        notificationType: auxiliary ? content.auxiliaryType : content.type,
        idempotencyKey: `calendar:${event._id}:${idempotencySuffix}:${role}:${id}`,
      });
    }));
  } catch (error) {
    console.error('[Notifications] No se pudo procesar un aviso de visita:', error.message);
  }
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
  let accessibleAgencyIds = null;
  if (req.user.rol === 'consultor') {
    accessibleAgencyIds = await Agency.find(getAgencyConsultantFilter(req.user._id)).distinct('_id');
    filter.agencyId = { $in: accessibleAgencyIds };
  }
  if (req.query.agencyId !== undefined) {
    if (!validId(req.query.agencyId)) return validationFailure(res, { agencyId: 'Must be a valid ID' });
    if (req.user.rol === 'consultor'
      && !accessibleAgencyIds.some((id) => String(id) === req.query.agencyId)) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    filter.agencyId = req.query.agencyId;
  }
  let selectedConsultantId = null;
  if (req.query.consultantId !== undefined) {
    if (req.query.consultantId === 'me') selectedConsultantId = req.user._id;
    else if (!validId(req.query.consultantId)) {
      return validationFailure(res, { consultantId: 'Must be a valid ID or "me"' });
    } else selectedConsultantId = req.query.consultantId;
  }
  if (req.query.view === 'mine') selectedConsultantId = req.user._id;
  if (selectedConsultantId) {
    const assignedAgencyIds = await Agency.find(
      getAgencyConsultantFilter(selectedConsultantId),
    ).distinct('_id');
    filter.$or = [
      { consultantId: selectedConsultantId },
      { agencyId: { $in: assignedAgencyIds } },
    ];
  }
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
    await ensureMonthlyRecalendarization(getPeriodForRange(rangeStart, rangeEnd));
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
      const agencies = await Agency.find(
        getAgencyConsultantFilter(req.user._id),
      ).select('consultantId auxiliaryConsultantId').lean();
      const consultantIds = [...new Set([String(req.user._id), ...agencies.flatMap((agency) => (
        getAgencyConsultants(agency).map(({ id }) => id)
      ))])];
      const consultants = await User.find({
        _id: { $in: consultantIds },
        rol: 'consultor',
        status: 'activo',
      })
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

async function resolveCalendarConsultantId(event) {
  if (event.consultantId) return event.consultantId;
  if (event.type !== 'agency_visit' || !event.agencyId) return null;
  const agency = await Agency.findById(event.agencyId).select('consultantId').lean();
  return agency?.consultantId || null;
}

function availabilityFailure(res, availability, code, message) {
  if (availability.error) return validationFailure(res, { startAt: availability.error });
  if (availability.conflict) {
    const suggestedStartAt = availability.conflict.suggestedStartAt;
    const suggestionMessage = suggestedStartAt
      ? ` La fecha más próxima disponible es ${formatSuggestedStartAt(suggestedStartAt)}.`
      : ' No queda otro horario disponible dentro del mes seleccionado.';
    return res.status(409).json({
      success: false,
      message: `${message}${suggestionMessage}`,
      code,
      suggestedStartAt: suggestedStartAt?.toISOString() || null,
      suggestedEndAt: availability.conflict.suggestedEndAt?.toISOString() || null,
    });
  }
  return null;
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
    if (value.type === 'agency_visit') {
      const consultantId = await resolveCalendarConsultantId(value);
      const availability = await validateCalendarSlots([{
        startAt: value.startAt,
        endAt: value.endAt,
      }], { consultantId });
      const failed = availabilityFailure(
        res,
        availability,
        'CALENDAR_CONSULTANT_UNAVAILABLE',
        'El consultor no está disponible en ese horario. Deja un margen mínimo de 15 minutos entre visitas.',
      );
      if (failed) return failed;
      if (consultantId) value.consultantId = consultantId;
    }
    const event = await CalendarEvent.create({
      ...value,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    if (event.authorized) await notifyVisitChange(event, 'scheduled', `created:${event.updatedAt.getTime()}`);
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
    let seriesConsultantId = value.event.consultantId;
    if (value.event.type === 'agency_visit') {
      seriesConsultantId = await resolveCalendarConsultantId(value.event);
      const availability = await validateCalendarSlots(
        value.occurrences.map(({ startAt, endAt }) => ({
          startAt: parseDate(startAt),
          endAt: parseDate(endAt),
        })),
        { consultantId: seriesConsultantId },
      );
      const failed = availabilityFailure(
        res,
        availability,
        'CALENDAR_CONSULTANT_UNAVAILABLE',
        'No se puede guardar la serie: cada visita debe dejar al consultor disponible y respetar 15 minutos entre actividades.',
      );
      if (failed) return failed;
    }
    const recurrenceSeriesId = new mongoose.Types.ObjectId();
    const recurrence = {
      frequency: value.recurrence.frequency,
      interval: value.recurrence.interval,
      daysOfWeek: value.recurrence.frequency === 'weekly' ? value.recurrence.daysOfWeek : [],
      endDate: value.recurrence.endDate,
    };
    const documents = value.occurrences.map((occurrence) => new CalendarEvent({
      ...value.event,
      ...(value.event.type === 'agency_visit' ? { consultantId: seriesConsultantId } : {}),
      startAt: parseDate(occurrence.startAt),
      endAt: parseDate(occurrence.endAt),
      recurrenceSeriesId,
      recurrence,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    }));
    await Promise.all(documents.map((event) => event.validate()));
    const createdEvents = await CalendarEvent.insertMany(documents, { ordered: true });
    if (value.event.authorized) {
      await Promise.all(createdEvents.map((event) => notifyVisitChange(
        event,
        'scheduled',
        `created:${event.updatedAt.getTime()}`,
      )));
    }
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
    const previousEvent = {
      _id: event._id,
      title: event.title,
      type: event.type,
      agencyId: event.agencyId,
      consultantId: event.consultantId,
      authorized: event.authorized,
      startAt: event.startAt,
      endAt: event.endAt,
      updatedAt: event.updatedAt,
    };
    const previousRecipient = previousEvent.authorized
      ? await getVisitConsultant(previousEvent)
      : null;
    if (value.startAt === undefined && value.endAt !== undefined) value.startAt = event.startAt;
    if (value.endAt === undefined && value.startAt !== undefined) value.endAt = event.endAt;
    if (value.endAt && value.startAt && value.endAt <= value.startAt) {
      return validationFailure(res, { endAt: 'Must be later than startAt' });
    }
    if (!await validateRelations(value, res)) return;
    const nextType = value.type || event.type;
    const requestedAgencyId = value.agencyId === undefined ? event.agencyId : value.agencyId;
    let nextConsultantId = value.consultantId === undefined
      ? event.consultantId
      : value.consultantId;
    const agencyChanged = value.agencyId !== undefined
      && String(value.agencyId || '') !== String(event.agencyId || '');
    if (nextType === 'agency_visit' && agencyChanged && value.consultantId === undefined) {
      nextConsultantId = null;
    }
    if (nextType === 'agency_visit' && (value.startAt !== undefined
      || value.endAt !== undefined
      || value.consultantId !== undefined
      || agencyChanged
      || value.type !== undefined)) {
      nextConsultantId = await resolveCalendarConsultantId({
        type: nextType,
        agencyId: requestedAgencyId,
        consultantId: nextConsultantId,
      });
      const availability = await validateCalendarSlots([{
        startAt: value.startAt || event.startAt,
        endAt: value.endAt || event.endAt,
      }], {
        consultantId: nextConsultantId,
        excludeEventId: event._id,
      });
      const failed = availabilityFailure(
        res,
        availability,
        'CALENDAR_CONSULTANT_UNAVAILABLE',
        'El consultor no está disponible en ese horario. Deja un margen mínimo de 15 minutos entre visitas.',
      );
      if (failed) return failed;
      value.consultantId = nextConsultantId;
    }
    const previousAgencyId = eventAgencyId(event);
    const previousTitle = event.title;
    Object.assign(event, value, { updatedBy: req.user._id });
    await event.save();
    const nextRecipient = event.authorized ? await getVisitConsultant(event) : null;
    const scheduleChanged = previousEvent.startAt.getTime() !== event.startAt.getTime()
      || previousEvent.endAt.getTime() !== event.endAt.getTime()
      || previousEvent.agencyId?.toString() !== event.agencyId?.toString()
      || previousEvent.title !== event.title;
    const previousRecipientIds = new Set((previousRecipient?.consultants || []).map(({ id }) => id));
    const nextRecipientIds = new Set((nextRecipient?.consultants || []).map(({ id }) => id));
    const recipientChanged = previousRecipientIds.size !== nextRecipientIds.size
      || [...previousRecipientIds].some((id) => !nextRecipientIds.has(id));
    if (scheduleChanged && event.type === 'agency_visit') {
      await AgencyMonthlyInspection.updateOne(
        { calendarEventId: event._id },
        {
          $set: {
            attendanceStatus: nextRecipient?.consultants.some(({ role }) => role === 'auxiliary')
              ? 'pending'
              : null,
            attendanceConfirmedBy: null,
            attendanceConfirmedAt: null,
          },
        },
      );
    }
    if (previousRecipient && (!nextRecipient || recipientChanged || !event.authorized)) {
      await notifyVisitChange(previousEvent, 'cancelled', `cancelled:${event.updatedAt.getTime()}`);
    }
    if (nextRecipient && (recipientChanged || !previousRecipient || scheduleChanged)) {
      const notice = previousEvent.authorized && !recipientChanged
        ? 'changed'
        : previousEvent.authorized
          ? 'scheduled'
          : 'authorized';
      await notifyVisitChange(event, notice, `${notice}:${event.updatedAt.getTime()}`);
    }
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
    const event = await CalendarEvent.findById(req.params.id);
    if (!event) return res.status(404).json({ success: false, message: 'Calendar event not found' });
    if (event.authorized) await notifyVisitChange(event, 'cancelled', `deleted:${event.updatedAt.getTime()}`);
    await event.deleteOne();
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
