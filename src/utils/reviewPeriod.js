'use strict';

function resolveReviewPeriod(inspectionPeriod, settings) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(inspectionPeriod || '') || !settings?.startPeriod) {
    return inspectionPeriod;
  }
  const [year, month] = inspectionPeriod.split('-').map(Number);
  const [startYear, startMonth] = settings.startPeriod.split('-').map(Number);
  const elapsedMonths = (year - startYear) * 12 + month - startMonth;
  if (elapsedMonths < 0) return inspectionPeriod;
  const scheduledMonth = startMonth - 1
    + Math.floor(elapsedMonths / settings.intervalMonths) * settings.intervalMonths;
  const scheduledYear = startYear + Math.floor(scheduledMonth / 12);
  const normalizedMonth = (scheduledMonth % 12) + 1;
  return `${scheduledYear}-${String(normalizedMonth).padStart(2, '0')}`;
}

function getReviewIntervalMonths(reviewPeriods, category) {
  const settings = reviewPeriods?.get?.(category) || reviewPeriods?.[category];
  const intervalMonths = Number(settings?.intervalMonths);
  return Number.isInteger(intervalMonths) && intervalMonths >= 1 && intervalMonths <= 120
    ? intervalMonths
    : 1;
}

module.exports = { getReviewIntervalMonths, resolveReviewPeriod };
