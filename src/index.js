require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const routes = require('./routes');
const auditActivity = require('./middlewares/auditActivity');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const { startMailJobWorker } = require('./services/mailJobWorker');
const { startAgencyRefreshJobWorker } = require('./services/agencyRefreshJobWorker');
const { logServerEvent } = require('./utils/serverLogger');

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((origin) => origin.trim());

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(auditActivity);
app.use('/api', routes);

app.get('/', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const databaseConnected = mongoose.connection.readyState === 1;
  res.json({
    status: databaseConnected ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    pid: process.pid,
    database: databaseConnected ? 'connected' : 'disconnected',
    memory: {
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
    },
  });
});

app.use(notFound);
app.use(errorHandler);

connectDB().then(async () => {
  await startMailJobWorker();
  await startAgencyRefreshJobWorker();
  app.listen(PORT, async () => {
    await logServerEvent('server_started');
    console.info(JSON.stringify({
      status: 'ready',
      port: PORT,
      pid: process.pid,
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    }));
  });
});
