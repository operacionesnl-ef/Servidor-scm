'use strict';

const CalendarEvent = require('../models/CalendarEvent');
const {
  MINIMUM_GAP_MINUTES,
  TIME_ZONE,
  findNextAvailableSlot,
  getLocalParts,
  getPeriodForDate,
  getPeriodRange,
  getWorkingHours,
  isFederalHoliday,
  localDateTimeToUtc,
} = require('./monthlyRecalendarization');

function getMinutesOfDay(parts) {
  return parts.hour * 60
    + parts.minute
    + parts.second / 60
    + parts.millisecond / 60_000;
}

function validateWorkingSlot(slot, period) {
  const startAt = new Date(slot.startAt);
  const endAt = new Date(slot.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    return { error: 'La hora de término debe ser posterior a la hora de inicio.' };
  }
  if (period && getPeriodForDate(startAt) !== period) {
    return { error: `La visita debe programarse dentro del período ${period}.` };
  }

  const start = getLocalParts(startAt);
  const end = getLocalParts(endAt);
  if (start.year !== end.year || start.month !== end.month || start.day !== end.day) {
    return { error: 'La visita debe terminar el mismo día laboral en que inicia.' };
  }

  const workHours = getWorkingHours(start);
  if (!workHours) {
    const weekday = new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay();
    return {
      error: isFederalHoliday(start)
        ? 'La fecha seleccionada es un día festivo y no está disponible para visitas.'
        : weekday === 0
          ? 'No es posible programar visitas los domingos. Selecciona una fecha de lunes a sábado.'
          : 'La fecha seleccionada no es laborable.',
    };
  }

  const startMinute = getMinutesOfDay(start);
  const endMinute = getMinutesOfDay(end);
  if (startMinute < workHours.opening || endMinute > workHours.closing) {
    const message = workHours.closing === 12 * 60
      ? 'El horario seleccionado no está disponible. Los sábados, las visitas deben programarse entre 09:00 y 12:00.'
      : 'El horario seleccionado no está disponible. De lunes a viernes, las visitas deben programarse entre 08:00 y 17:00.';
    return { error: message };
  }
  return { error: null };
}

function hasScheduleConflict(slot, reservation, gapMilliseconds) {
  return slot.startAt.getTime() < reservation.endAt.getTime() + gapMilliseconds
    && slot.endAt.getTime() > reservation.startAt.getTime() - gapMilliseconds;
}

function formatSuggestedStartAt(value) {
  const date = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TIME_ZONE,
  }).format(value);
  const time = new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: TIME_ZONE,
  }).format(value);
  return `${date} a las ${time}`;
}

async function findMonthReservations(period, consultantId, excludeEventId) {
  const range = getPeriodRange(period);
  const events = await CalendarEvent.find({
    consultantId: consultantId._id || consultantId,
    startAt: { $lt: range.end },
    endAt: { $gt: range.start },
    ...(excludeEventId ? { _id: { $ne: excludeEventId } } : {}),
  })
    .select('_id title startAt endAt')
    .lean();
  return events.map((event) => ({
    _id: event._id,
    title: event.title,
    startAt: new Date(event.startAt),
    endAt: new Date(event.endAt),
  }));
}

async function findSuggestedSlot(slot, reservations) {
  const sourceLocal = getLocalParts(slot.startAt);
  const period = getPeriodForDate(slot.startAt);
  const monthReservations = await findMonthReservations(
    period,
    slot.consultantId,
    slot.excludeEventId,
  );
  const alternative = findNextAvailableSlot(
    { year: sourceLocal.year, month: sourceLocal.month, day: sourceLocal.day },
    period,
    (slot.endAt.getTime() - slot.startAt.getTime()) / 60_000,
    [...monthReservations, ...reservations],
    getMinutesOfDay(sourceLocal),
  );
  if (!alternative) return null;

  const startAt = localDateTimeToUtc({
    ...alternative.date,
    hour: Math.floor(alternative.startMinute / 60),
    minute: Math.floor(alternative.startMinute % 60),
  });
  return {
    startAt,
    endAt: new Date(startAt.getTime() + (slot.endAt.getTime() - slot.startAt.getTime())),
  };
}

async function validateCalendarSlots(slots, {
  consultantId = null,
  excludeEventId = null,
  period = null,
} = {}) {
  const normalizedSlots = slots.map((slot) => ({
    startAt: new Date(slot.startAt),
    endAt: new Date(slot.endAt),
  }));
  for (const slot of normalizedSlots) {
    const result = validateWorkingSlot(slot, period);
    if (result.error) return result;
  }
  if (!consultantId || !normalizedSlots.length) return { error: null, conflict: null };

  const gapMilliseconds = MINIMUM_GAP_MINUTES * 60_000;
  const earliestStart = Math.min(...normalizedSlots.map(({ startAt }) => startAt.getTime()));
  const latestEnd = Math.max(...normalizedSlots.map(({ endAt }) => endAt.getTime()));
  const query = {
    consultantId: consultantId._id || consultantId,
    startAt: { $lt: new Date(latestEnd + gapMilliseconds) },
    endAt: { $gt: new Date(earliestStart - gapMilliseconds) },
    ...(excludeEventId ? { _id: { $ne: excludeEventId } } : {}),
  };
  const existingEvents = await CalendarEvent.find(query)
    .select('_id title startAt endAt')
    .lean();
  const reservations = existingEvents.map((event) => ({
    _id: event._id,
    title: event.title,
    startAt: new Date(event.startAt),
    endAt: new Date(event.endAt),
  }));

  const orderedSlots = normalizedSlots
    .map((slot, index) => ({ ...slot, index }))
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
  for (const slot of orderedSlots) {
    const conflict = reservations.find((reservation) => (
      hasScheduleConflict(slot, reservation, gapMilliseconds)
    ));
    if (conflict) {
      const suggestion = await findSuggestedSlot({
        ...slot,
        consultantId,
        excludeEventId,
      }, reservations);
      return {
        error: null,
        conflict: {
          slot,
          reservation: conflict,
          suggestedStartAt: suggestion?.startAt || null,
          suggestedEndAt: suggestion?.endAt || null,
        },
      };
    }
    reservations.push(slot);
  }
  return { error: null, conflict: null };
}

module.exports = {
  formatSuggestedStartAt,
  hasScheduleConflict,
  validateCalendarSlots,
  validateWorkingSlot,
};
