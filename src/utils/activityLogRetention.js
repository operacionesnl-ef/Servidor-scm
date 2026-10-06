'use strict';

const ACTIVITY_LOG_RETENTION_DAYS = 14;
const ACTIVITY_LOG_RETENTION_MS = ACTIVITY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function getActivityLogExpiryDate(referenceDate = new Date()) {
  return new Date(referenceDate.getTime() + ACTIVITY_LOG_RETENTION_MS);
}

module.exports = {
  ACTIVITY_LOG_RETENTION_DAYS,
  ACTIVITY_LOG_RETENTION_MS,
  getActivityLogExpiryDate,
};
