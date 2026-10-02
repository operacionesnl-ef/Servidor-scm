const ServerEvent = require('../models/ServerEvent');

function logConsoleEvent(event, details = {}) {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

async function logServerEvent(event, details = {}) {
  const at = new Date();
  const summary = {
    at: at.toISOString(),
    e: event,
    ...(details.userId ? { u: String(details.userId) } : {}),
    ...(details.jobId ? { j: String(details.jobId) } : {}),
    ...(details.status ? { s: details.status } : {}),
    ...(details.completed != null ? { c: details.completed } : {}),
    ...(details.total != null ? { n: details.total } : {}),
  };

  try {
    await ServerEvent.create({
      e: event,
      u: details.userId,
      j: details.jobId,
      s: details.status,
      c: details.completed,
      n: details.total,
      at,
    });
  } catch {
    console.error(JSON.stringify({ at: summary.at, e: 'event_store_failed', ref: event }));
  }

  logConsoleEvent(event, summary);
}

module.exports = { logConsoleEvent, logServerEvent };