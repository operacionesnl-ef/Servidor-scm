'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyMonthlyInspection = require('../models/AgencyMonthlyInspection');
const CalendarEvent = require('../models/CalendarEvent');
const { success } = require('../utils/response');
const { recordAgencyHistory } = require('../services/agencyHistory');
const { notifyAgencyConsultants } = require('../services/consultantNotifications');
const { ensureMonthlyRecalendarization } = require('../services/monthlyRecalendarization');
const {
  formatSuggestedStartAt,
  validateCalendarSlots,
} = require('../services/calendarAvailability');
const {
  getAgencyConsultantFilter,
  getAgencyConsultants,
} = require('../utils/agencyConsultants');

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
    scheduleStatus: record.scheduleStatus || (record.calendarEventId ? 'scheduled' : 'pending'),
    scheduleReason: record.scheduleReason || '',
    scheduleGenerationId: record.scheduleGenerationId ? String(record.scheduleGenerationId) : null,
    attendanceStatus: record.attendanceStatus || null,
    attendanceConfirmedBy: record.attendanceConfirmedBy
      ? String(record.attendanceConfirmedBy)
      : null,
    attendanceConfirmedAt: record.attendanceConfirmedAt || null,
    calendarEventId: record.calendarEventId ? String(record.calendarEventId) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function findAgencyOr404(agencyId, res) {
  const agency = await Agency.findById(agencyId)
    .select('_id nombre consultantId auxiliaryConsultantId status');
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
    await ensureMonthlyRecalendarization(req.params.period);
    const record = await AgencyMonthlyInspection.findOne({
      agencyId: req.params.id,
      period: req.params.period,
    }).lean();
    return success(res, { record: record ? serializeRecord(record) : null }, 'Monthly inspection fetched');
  } catch (error) {
    return next(error);
  }
}

async function getMonthlyInspectionOverview(req, res, next) {
  if (!validPeriod(req.params.period, res)) return;
  try {
    await ensureMonthlyRecalendarization(req.params.period);
    const agencies = await Agency.find({
      ...(req.user?.rol === 'consultor' ? getAgencyConsultantFilter(req.user._id) : {}),
    }).select('_id nombre').lean();
    const agencyIds = agencies.map((agency) => agency._id);
    const records = agencyIds.length
      ? await AgencyMonthlyInspection.find({ agencyId: { $in: agencyIds }, period: req.params.period })
        .select('agencyId authorizationStatus visitStatus scheduleStatus scheduleReason calendarEventId')
        .lean()
      : [];
    const recordByAgencyId = new Map(records.map((record) => [String(record.agencyId), record]));
    const eventIds = records.map((record) => record.calendarEventId).filter(Boolean);
    const linkedEvents = eventIds.length
      ? await CalendarEvent.find({
        _id: { $in: eventIds },
        agencyId: { $in: agencyIds },
        type: 'agency_visit',
      }).select('_id agencyId').lean()
      : [];
    const linkedEventKeys = new Set(linkedEvents.map((event) => `${event.agencyId}:${event._id}`));

    return success(res, {
      period: req.params.period,
      agencies: agencies.map((agency) => {
        const record = recordByAgencyId.get(String(agency._id));
        const calendarEventId = record?.calendarEventId ? String(record.calendarEventId) : null;
        return {
          agencyId: String(agency._id),
          agencyName: agency.nombre,
          authorizationStatus: record?.authorizationStatus || 'pending',
          visitStatus: record?.visitStatus || 'pending',
          scheduleStatus: record?.scheduleStatus || (record?.calendarEventId ? 'scheduled' : 'pending'),
          scheduleReason: record?.scheduleReason || '',
          calendarEventId,
          calendarEventExists: Boolean(calendarEventId
            && linkedEventKeys.has(`${agency._id}:${record.calendarEventId}`)),
        };
      }),
    }, 'Monthly inspection overview fetched');
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
    const agency = await findAgencyOr404(req.params.id, res);
    if (!agency) return;
    const previous = await AgencyMonthlyInspection.findOne({
      agencyId: req.params.id,
      period: req.params.period,
    }).select('authorizationStatus calendarEventId').lean();
    const authorizationChanged = (previous?.authorizationStatus || 'pending') !== authorizationStatus;
    const attendanceFields = authorizationChanged
      ? authorizationStatus === 'authorized' && previous?.calendarEventId
        ? {
          attendanceStatus: 'pending',
          attendanceConfirmedBy: null,
          attendanceConfirmedAt: null,
        }
        : {
          attendanceStatus: null,
          attendanceConfirmedBy: null,
          attendanceConfirmedAt: null,
        }
      : {};
    const record = await AgencyMonthlyInspection.findOneAndUpdate(
      { agencyId: req.params.id, period: req.params.period },
      {
        $set: { authorizationStatus, ...attendanceFields },
        $setOnInsert: { visitStatus: 'pending' },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    if (record.calendarEventId) {
      try {
        await CalendarEvent.updateOne(
          { _id: record.calendarEventId, agencyId: agency._id, type: 'agency_visit' },
          { $set: { authorized: authorizationStatus === 'authorized', updatedBy: req.user._id } },
        );
      } catch (error) {
        console.error('[Calendar] No se pudo sincronizar la autorización de la visita:', error.message);
      }
    }
    if ((previous?.authorizationStatus || 'pending') !== authorizationStatus) {
      await recordAgencyHistory({
        agencyId: agency._id,
        actor: req.user,
        action: 'monthly_authorization_updated',
        summary: `Autorización mensual ${authorizationStatus === 'unauthorized' ? 'no autorizada' : authorizationStatus === 'authorized' ? 'autorizada' : 'pendiente'}`,
        details: {
          period: req.params.period,
          from: previous?.authorizationStatus || 'pending',
          to: authorizationStatus,
        },
      });
      if (getAgencyConsultants(agency).length && authorizationStatus !== 'pending') {
        const approved = authorizationStatus === 'authorized';
        await notifyAgencyConsultants(agency, {
          title: approved ? 'Visita autorizada' : 'Visita no autorizada',
          message: approved
            ? `Se autorizó tu visita a ${agency.nombre} para el período ${req.params.period}.`
            : `La visita a ${agency.nombre} para el período ${req.params.period} no fue autorizada.`,
          auxiliaryTitle: approved ? 'Visita autorizada · Auxiliar' : 'Visita no autorizada · Auxiliar',
          auxiliaryMessage: approved
            ? `Se autorizó la visita a ${agency.nombre} para el período ${req.params.period}. Al programarse, recibirás una solicitud para confirmar quién asistirá.`
            : `La visita a ${agency.nombre} para el período ${req.params.period} no fue autorizada.`,
          notificationType: approved ? 'visit_authorized' : 'visit_not_authorized',
          actionUrl: `/agencias/${agency._id}?tab=inspections`,
          agencyId: agency._id,
          idempotencyKey: `monthly:${agency._id}:${req.params.period}:authorization:${authorizationStatus}:${record.updatedAt.getTime()}`,
        });
      }
    }
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

    // ── Obtener o crear el registro mensual ──────────────────────────────
    const record = await AgencyMonthlyInspection.findOneAndUpdate(
      { agencyId: agency._id, period: req.params.period },
      { $setOnInsert: { authorizationStatus: 'pending', visitStatus: 'pending' } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    // ── Bloquear reprogramación si la visita ya fue completada ───────────
    if (record.visitStatus === 'completed') {
      return res.status(409).json({
        success: false,
        message: 'La visita de este período ya fue marcada como realizada y no puede reprogramarse.',
        code: 'MONTHLY_VISIT_ALREADY_COMPLETED',
      });
    }

    const availability = await validateCalendarSlots([{
      startAt: value.startAt,
      endAt: value.endAt,
    }], {
      consultantId: agency.consultantId,
      excludeEventId: record.calendarEventId,
      period: req.params.period,
    });
    if (availability.error) {
      return validationFailure(res, { startAt: availability.error });
    }
    if (availability.conflict) {
      const suggestedStartAt = availability.conflict.suggestedStartAt;
      const suggestionMessage = suggestedStartAt
        ? ` La fecha más próxima disponible es ${formatSuggestedStartAt(suggestedStartAt)}.`
        : ' No queda otro horario disponible dentro del mes seleccionado.';
      return res.status(409).json({
        success: false,
        message: `El consultor no está disponible en ese horario. Deja un margen mínimo de 15 minutos entre visitas.${suggestionMessage}`,
        code: 'MONTHLY_VISIT_CONFLICT',
        suggestedStartAt: suggestedStartAt?.toISOString() || null,
        suggestedEndAt: availability.conflict.suggestedEndAt?.toISOString() || null,
      });
    }

    // ── Datos del evento a crear o actualizar ────────────────────────────
    const isRescheduling = Boolean(record.calendarEventId);
    const eventData = {
      title: `Visita: ${agency.nombre}`,
      type: 'agency_visit',
      startAt: value.startAt,
      endAt: value.endAt,
      agencyId: agency._id,
      consultantId: agency.consultantId,
      notes: req.body.notes?.trim() || '',
      authorized: record.authorizationStatus === 'authorized',
      reminders: req.body.reminders || { enabled: false, minutesBefore: [] },
      updatedBy: req.user._id,
    };

    let event;

    if (record.calendarEventId) {
      // ── Ya existe un evento vinculado: actualizarlo (reprogramación) ───
      event = await CalendarEvent.findOneAndUpdate(
        { _id: record.calendarEventId, agencyId: agency._id, type: 'agency_visit' },
        { $set: eventData },
        { new: true },
      );

      if (!event) {
        // El ID quedó huérfano — limpiar y crear uno nuevo
        await AgencyMonthlyInspection.updateOne(
          { _id: record._id },
          {
            $set: {
              calendarEventId: null,
              visitStatus: 'scheduled',
              scheduleStatus: 'pending',
              scheduleReason: '',
              attendanceStatus: null,
              attendanceConfirmedBy: null,
              attendanceConfirmedAt: null,
            },
          },
        );
        record.calendarEventId = null;
      }
    }

    if (!event) {
      // ── Crear evento nuevo ─────────────────────────────────────────────
      const newEventId = new mongoose.Types.ObjectId();

      // Reservar el ID en el registro antes de escribir en CalendarEvent
      const reserved = await AgencyMonthlyInspection.updateOne(
        { _id: record._id, calendarEventId: null },
        {
          $set: {
            calendarEventId: newEventId,
            visitStatus: 'scheduled',
            scheduleStatus: 'scheduled',
            scheduleReason: '',
            attendanceStatus: agency.auxiliaryConsultantId ? 'pending' : null,
            attendanceConfirmedBy: null,
            attendanceConfirmedAt: null,
          },
        },
      );

      if (!reserved.modifiedCount) {
        // Otra petición se adelantó y reservó un ID — devolver el estado actual
        const latest = await AgencyMonthlyInspection.findById(record._id).lean();
        return res.status(409).json({
          success: false,
          message: 'La visita ya está siendo programada por otra solicitud. Recarga la página.',
          code: 'MONTHLY_VISIT_CONCURRENT',
          record: latest ? serializeRecord(latest) : null,
        });
      }

      event = await CalendarEvent.create({
        _id: newEventId,
        ...eventData,
        createdBy: req.user._id,
      });
    }

    // ── Actualizar visitStatus a 'scheduled' si no lo estaba ya ─────────
    await AgencyMonthlyInspection.updateOne(
      { _id: record._id },
      {
        $set: {
          visitStatus: 'scheduled',
          scheduleStatus: 'scheduled',
          scheduleReason: '',
          calendarEventId: event._id,
          attendanceStatus: agency.auxiliaryConsultantId ? 'pending' : null,
          attendanceConfirmedBy: null,
          attendanceConfirmedAt: null,
        },
      },
    );
    const visitDate = new Date(event.startAt).toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Mexico_City',
    });
    if (record.authorizationStatus === 'authorized') {
      await notifyAgencyConsultants(agency, {
        title: isRescheduling ? 'Cambio de visita' : 'Visita programada',
        message: isRescheduling
          ? `La visita a ${agency.nombre} cambió. Nueva fecha: ${visitDate}.`
          : `Tu visita a ${agency.nombre} está programada para el ${visitDate}.`,
        auxiliaryTitle: isRescheduling
          ? 'Cambio de visita · Confirmación pendiente'
          : 'Visita programada · Confirmación pendiente',
        auxiliaryMessage: `La visita a ${agency.nombre} está programada para el ${visitDate}. Confirma en Inspecciones si asistirás tú o el consultor principal.`,
        notificationType: isRescheduling ? 'visit_changed' : 'visit_scheduled',
        actionUrl: `/agencias/${agency._id}?tab=inspections`,
        agencyId: agency._id,
        idempotencyKey: `monthly:${agency._id}:${req.params.period}:${isRescheduling ? 'rescheduled' : 'scheduled'}:${event.startAt.getTime()}`,
      });
    }

    await recordAgencyHistory({
      agencyId: agency._id,
      actor: req.user,
      action: 'monthly_visit_scheduled',
      summary: record.calendarEventId
        ? 'Visita mensual reprogramada'
        : 'Visita mensual programada',
      details: {
        period: req.params.period,
        startAt: event.startAt,
        endAt: event.endAt,
      },
    });

    const updatedRecord = await AgencyMonthlyInspection.findById(record._id).lean();

    return success(res, {
      record: serializeRecord(updatedRecord),
      calendarEvent: {
        id: String(event._id),
        title: event.title,
        type: event.type,
        startAt: event.startAt,
        endAt: event.endAt,
        agencyId: String(event.agencyId),
        consultantId: String(event.consultantId),
        consultantIds: getAgencyConsultants(agency).map(({ id }) => id),
      },
    }, 'Monthly visit scheduled', 201);

  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A calendar visit is already linked to this period.',
      });
    }
    if (error.name === 'ValidationError') {
      return validationFailure(res, Object.fromEntries(
        Object.entries(error.errors).map(([field, detail]) => [field, detail.message]),
      ));
    }
    return next(error);
  }
}

async function confirmMonthlyVisitAttendance(req, res, next) {
  if (!validAgencyId(req.params.id, res) || !validPeriod(req.params.period, res)) return;
  const { attendanceStatus } = req.body || {};
  if (Object.keys(req.body || {}).some((field) => field !== 'attendanceStatus')
    || !['primary', 'auxiliary'].includes(attendanceStatus)) {
    return validationFailure(res, { attendanceStatus: 'Must be primary or auxiliary' });
  }
  if (req.user?.rol !== 'consultor') {
    return res.status(403).json({ success: false, message: 'Only the assigned auxiliary consultant can confirm attendance.' });
  }
  try {
    const agency = await Agency.findOne({
      _id: req.params.id,
      auxiliaryConsultantId: req.user._id,
    }).select('_id nombre consultantId auxiliaryConsultantId');
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    const record = await AgencyMonthlyInspection.findOne({
      agencyId: agency._id,
      period: req.params.period,
    });
    if (!record || record.authorizationStatus !== 'authorized'
      || record.visitStatus !== 'scheduled' || !record.calendarEventId) {
      return res.status(409).json({
        success: false,
        message: 'An authorized, scheduled visit is required before confirming attendance.',
      });
    }
    const eventExists = await CalendarEvent.exists({
      _id: record.calendarEventId,
      agencyId: agency._id,
      type: 'agency_visit',
      authorized: true,
    });
    if (!eventExists) {
      return res.status(409).json({ success: false, message: 'The scheduled visit is no longer available.' });
    }
    if (record.attendanceStatus !== 'pending') {
      if (record.attendanceStatus === attendanceStatus) {
        return success(res, serializeRecord(record), 'Visit attendance already confirmed');
      }
      return res.status(409).json({
        success: false,
        message: 'Visit attendance has already been confirmed.',
      });
    }
    record.attendanceStatus = attendanceStatus;
    record.attendanceConfirmedBy = req.user._id;
    record.attendanceConfirmedAt = new Date();
    await record.save();
    const attendeeName = attendanceStatus === 'auxiliary'
      ? 'el consultor auxiliar'
      : 'el consultor principal';
    await notifyAgencyConsultants(agency, {
      title: 'Asistencia confirmada',
      message: `Se confirmó que ${attendeeName} asistirá a la visita de ${agency.nombre}.`,
      auxiliaryTitle: 'Confirmaste la asistencia',
      auxiliaryMessage: `Confirmaste que ${attendeeName} asistirá a la visita de ${agency.nombre}.`,
      notificationType: 'visit_attendance_confirmed',
      actionUrl: `/agencias/${agency._id}?tab=inspections`,
      agencyId: agency._id,
      idempotencyKey: `monthly:${agency._id}:${req.params.period}:attendance:${attendanceStatus}:${record.updatedAt.getTime()}`,
    });
    await recordAgencyHistory({
      agencyId: agency._id,
      actor: req.user,
      action: 'monthly_visit_attendance_confirmed',
      summary: `Asistencia confirmada: ${attendeeName}`,
      details: { period: req.params.period, attendanceStatus },
    });
    return success(res, serializeRecord(record), 'Visit attendance confirmed');
  } catch (error) {
    return next(error);
  }
}

async function updateMonthlyVisitStatus(req, res, next) {
  if (!validAgencyId(req.params.id, res) || !validPeriod(req.params.period, res)) return;
  if (!['admin', 'developer', 'consultor'].includes(req.user?.rol)) {
    return res.status(403).json({ success: false, message: 'You are not authorized to mark visits as completed.' });
  }
  if (Object.keys(req.body || {}).some((field) => field !== 'status')
    || req.body?.status !== 'completed') {
    return validationFailure(res, { status: 'Must be completed; create a calendar visit to schedule it' });
  }
  try {
    if (req.user?.rol === 'consultor'
      && !await Agency.exists({
        _id: req.params.id,
        ...getAgencyConsultantFilter(req.user._id),
      })) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    const record = await AgencyMonthlyInspection.findOne({
      agencyId: req.params.id,
      period: req.params.period,
    });
    if (!record) return res.status(404).json({ success: false, message: 'Monthly inspection not found' });
    if (record.visitStatus !== 'scheduled') {
      return res.status(409).json({ success: false, message: 'Only a scheduled visit can be marked as completed.' });
    }
    if (!record.calendarEventId || !await CalendarEvent.exists({
      _id: record.calendarEventId,
      agencyId: req.params.id,
      type: 'agency_visit',
    })) {
      return validationFailure(res, { status: 'A linked calendar visit is required before completion' });
    }
    record.visitStatus = 'completed';
    await record.save();
    await recordAgencyHistory({
      agencyId: record.agencyId,
      actor: req.user,
      action: 'monthly_visit_completed',
      summary: 'Visita mensual marcada como realizada',
      details: { period: req.params.period },
    });
    return success(res, serializeRecord(record), 'Monthly visit marked completed');
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMonthlyInspection,
  getMonthlyInspectionOverview,
  scheduleMonthlyVisit,
  updateMonthlyAuthorization,
  updateMonthlyVisitStatus,
  confirmMonthlyVisitAttendance,
  validateVisitBody,
};