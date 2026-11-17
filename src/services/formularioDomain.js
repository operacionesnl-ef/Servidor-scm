const FORM_TIME_ZONE = 'America/Monterrey';
const PRIVACY_NOTICE_VERSION = '1';

const CURP_PATTERN = /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM](AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d$/;

const timeZoneFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FORM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(date) {
  return Object.fromEntries(timeZoneFormatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function dateFromZonedInput(value, dateOnly = false) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('La fecha no es válida.');
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error('La fecha es obligatoria.');
  const input = value.trim();
  if (/Z$|[+-]\d{2}:\d{2}$/.test(input)) {
    const instant = new Date(input);
    if (Number.isNaN(instant.getTime())) throw new Error('La fecha no es válida.');
    return instant;
  }

  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match || (!dateOnly && match[4] === undefined)) throw new Error('La fecha no tiene un formato válido.');
  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 0),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0),
  };
  const guess = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, desired.second);
  const checkDate = new Date(guess);
  if (checkDate.getUTCFullYear() !== desired.year
    || checkDate.getUTCMonth() + 1 !== desired.month
    || checkDate.getUTCDate() !== desired.day
    || desired.hour > 23
    || desired.minute > 59
    || desired.second > 59) {
    throw new Error('La fecha no es válida.');
  }

  let timestamp = guess;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(timestamp));
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    timestamp += guess - actualAsUtc;
  }
  const result = new Date(timestamp);
  const resolved = zonedParts(result);
  if (Object.keys(desired).some((key) => resolved[key] !== desired[key])) {
    throw new Error('La hora indicada no existe en la zona horaria del formulario.');
  }
  return result;
}

function calculateCloseDate(fechaApertura, duracionFormulario) {
  const duration = Number(duracionFormulario?.valor);
  const unitHours = { horas: 1, dias: 24, semanas: 168 }[duracionFormulario?.unidad];
  if (!Number.isFinite(duration) || duration <= 0 || !unitHours) {
    throw new Error('La duración del formulario debe ser mayor que cero y usar horas, días o semanas.');
  }
  return new Date(fechaApertura.getTime() + duration * unitHours * 60 * 60 * 1000);
}

function calculateFormStatus(formulario, now = new Date()) {
  if (formulario.cancelacion?.cancelado || formulario.estado === 'cancelado') return 'cancelado';
  const { fechaApertura, fechaCierre } = formulario.configuracionFechas || {};
  if (!fechaApertura || !fechaCierre) return 'incompleto';
  if (now < new Date(fechaApertura)) return 'programado';
  if (now >= new Date(fechaCierre)) return 'cerrado';
  return 'activo';
}

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-MX');
}

function isValidCurp(value, now = new Date()) {
  const curp = normalizeText(value);
  if (!CURP_PATTERN.test(curp)) return false;
  const curpAlphabet = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';
  const checkDigitSum = Array.from(curp.slice(0, 17)).reduce((sum, character, index) => (
    sum + curpAlphabet.indexOf(character) * (18 - index)
  ), 0);
  if ((10 - (checkDigitSum % 10)) % 10 !== Number(curp[17])) return false;
  const month = Number(curp.slice(6, 8));
  const day = Number(curp.slice(8, 10));
  const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: FORM_TIME_ZONE, year: 'numeric' }).format(now));
  const shortYear = Number(curp.slice(4, 6));
  const year = shortYear <= currentYear % 100 ? 2000 + shortYear : 1900 + shortYear;
  const birthDate = new Date(Date.UTC(year, month - 1, day));
  const todayParts = zonedParts(now);
  const today = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
  return month >= 1 && month <= 12
    && day >= 1
    && birthDate.getUTCFullYear() === year
    && birthDate.getUTCMonth() === month - 1
    && birthDate.getUTCDate() === day
    && birthDate.getTime() <= today;
}

function getAgencyBrand(agency) {
  return String(agency?.brand || agency?.marca || '').trim();
}

function brandKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-MX');
}

module.exports = {
  FORM_TIME_ZONE,
  PRIVACY_NOTICE_VERSION,
  calculateCloseDate,
  calculateFormStatus,
  dateFromZonedInput,
  getAgencyBrand,
  brandKey,
  isValidCurp,
  normalizeText,
};
