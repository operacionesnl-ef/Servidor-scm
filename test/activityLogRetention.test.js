'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const ActivityLog = require('../src/models/ActivityLog');
const { cleanupExpiredActivityLogs } = require('../src/services/activityLogCleanupWorker');
const {
  ACTIVITY_LOG_RETENTION_MS,
  getActivityLogExpiryDate,
} = require('../src/utils/activityLogRetention');

test('activity log expiry uses an exact 14-day period', () => {
  const reference = new Date('2026-10-01T12:00:00.000Z');
  assert.equal(getActivityLogExpiryDate(reference).toISOString(), '2026-10-15T12:00:00.000Z');
  assert.equal(ACTIVITY_LOG_RETENTION_MS, 14 * 24 * 60 * 60 * 1000);
});

test('cleanup deletes only activity logs older than the cutoff', async () => {
  const originalActivityDeleteMany = ActivityLog.deleteMany;
  let filter;
  ActivityLog.deleteMany = async (value) => {
    filter = value;
    return { deletedCount: 2 };
  };

  try {
    const now = new Date('2026-10-15T12:00:00.000Z');
    const result = await cleanupExpiredActivityLogs(now);

    assert.equal(result.cutoff.toISOString(), '2026-10-01T12:00:00.000Z');
    assert.equal(result.deleted, 2);
    assert.deepEqual(filter, { fecha: { $lt: result.cutoff } });
  } finally {
    ActivityLog.deleteMany = originalActivityDeleteMany;
  }
});
