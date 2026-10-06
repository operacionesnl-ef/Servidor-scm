'use strict';

const mongoose = require('mongoose');

function getHealth(_req, res) {
  const databaseConnected = mongoose.connection.readyState === 1;
  const status = databaseConnected ? 'ok' : 'degraded';

  return res.status(databaseConnected ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: databaseConnected ? 'connected' : 'disconnected',
  });
}

module.exports = { getHealth };
