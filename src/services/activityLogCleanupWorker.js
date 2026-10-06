'use strict';

const ActivityLog = require('../models/ActivityLog');
const { ACTIVITY_LOG_RETENTION_MS } = require('../utils/activityLogRetention');
const { logEvent } = require('../utils/consoleLogger');

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function cleanupExpiredActivityLogs(now = new Date()) {
  const cutoff = new Date(now.getTime() - ACTIVITY_LOG_RETENTION_MS);
  const activity = await ActivityLog.deleteMany({ fecha: { $lt: cutoff } });

  return {
    cutoff,
    deleted: activity.deletedCount,
  };
}

function startActivityLogCleanupWorker() {
  const runCleanup = async () => {
    try {
      const result = await cleanupExpiredActivityLogs();
      logEvent('activity_log_retention_cleanup', {
        cutoff: result.cutoff.toISOString(),
        deleted: result.deleted,
      });
    } catch (error) {
      logEvent('activity_log_retention_cleanup_failed', {
        message: error.message,
      });
    }
  };

  void runCleanup();
  const timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { cleanupExpiredActivityLogs, startActivityLogCleanupWorker };
