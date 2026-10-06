const ServerEvent = require('../models/ServerEvent');
const { logEvent } = require('./consoleLogger');

function logConsoleEvent(event, details = {}) {
  logEvent(event, { timestamp: new Date().toISOString(), ...details });
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
    logEvent('event_store_failed', { at: summary.at, message: `No se guardó el evento ${event}` });
  }

  logConsoleEvent(event, summary);
}

module.exports = { logConsoleEvent, logServerEvent };