'use strict';

const { logEvent } = require('../utils/consoleLogger');
const {
  ensureMonthlyRecalendarization,
  getNextMonthBoundary,
  getPeriodForDate,
} = require('./monthlyRecalendarization');

const MAX_TIMER_DELAY_MS = 2_147_000_000;
let workerPromise = null;
let workerPeriod = null;
let monthTimer = null;

function getTimerDelay(nextBoundary, now = Date.now()) {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, nextBoundary.getTime() - now));
}

function runMonthlyRecalendarization(now = new Date()) {
  const period = getPeriodForDate(now);
  if (workerPromise) {
    if (period === workerPeriod) return workerPromise;
    return workerPromise.then(() => runMonthlyRecalendarization(now));
  }
  workerPeriod = period;
  workerPromise = ensureMonthlyRecalendarization(period, now)
    .catch((error) => {
      logEvent('monthly_recalendarization_worker_failed', {
        period,
        message: error.message,
      });
      return null;
    })
    .finally(() => {
      workerPromise = null;
      workerPeriod = null;
    });
  return workerPromise;
}

function scheduleBoundary(nextBoundary) {
  const delay = getTimerDelay(nextBoundary);
  monthTimer = setTimeout(async () => {
    monthTimer = null;
    if (Date.now() < nextBoundary.getTime()) {
      scheduleBoundary(nextBoundary);
      return;
    }
    await runMonthlyRecalendarization();
    scheduleNextMonth();
  }, delay);
  monthTimer.unref?.();
  return monthTimer;
}

function scheduleNextMonth() {
  return scheduleBoundary(getNextMonthBoundary());
}

function startMonthlyRecalendarizationWorker() {
  if (monthTimer || workerPromise) return monthTimer || workerPromise;
  void runMonthlyRecalendarization().finally(() => {
    if (!monthTimer) scheduleNextMonth();
  });
  return workerPromise;
}

module.exports = {
  MAX_TIMER_DELAY_MS,
  getTimerDelay,
  runMonthlyRecalendarization,
  startMonthlyRecalendarizationWorker,
};
