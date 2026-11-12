'use strict';

const ADMIN_ROLES = new Set(['admin', 'developer']);

function currentMexicoPeriod() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find(({ type }) => type === 'year')?.value}-${parts.find(({ type }) => type === 'month')?.value}`;
}

function canSavePeriod(user, inspectionDate, currentPeriod = currentMexicoPeriod()) {
  const role = String(user?.rol || '').trim().toLowerCase();
  const reportPeriod = typeof inspectionDate === 'string' ? inspectionDate.slice(0, 7) : '';
  return reportPeriod >= currentPeriod || ADMIN_ROLES.has(role);
}

module.exports = { canSavePeriod, currentMexicoPeriod };
