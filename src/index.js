require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const webpush = require('web-push');
const connectDB = require('./config/db');
const routes = require('./routes');
const auditActivity = require('./middlewares/auditActivity');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const { startMailJobWorker } = require('./services/mailJobWorker');
const { startAgencyRefreshJobWorker } = require('./services/agencyRefreshJobWorker');
const { startActivityLogCleanupWorker } = require('./services/activityLogCleanupWorker');
const { logServerEvent } = require('./utils/serverLogger');
const { logStartup } = require('./utils/consoleLogger');
const { getHealth } = require('./controllers/healthController');
const { allowedOrigins } = require('./config/security');
const Subscription = require('./models/Subscription');

//  Ajusta esta ruta a donde tengas tu middleware de autenticación JWT
const authMiddleware = require('./middlewares/requireAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CORS + parsers ======
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ====== HEALTH (sin auth) ======
app.get('/health', getHealth);

// ====== WEB PUSH config ======
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  console.warn('[Push] Faltan VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY en el .env');
} else {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:admin@tudominio.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
  console.log('[Push] VAPID configurado correctamente');
}

// ====== RUTAS PUSH (ANTES de /api) ======

// Guardar/actualizar suscripción del dispositivo
app.post('/api/save-subscription', authMiddleware, async (req, res) => {
  const { subscription } = req.body;
  const userId = req.user._id;

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Suscripción inválida.' });
  }
  try {
    await Subscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        expirationTime: subscription.expirationTime ?? null,
        userId,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ message: 'Dispositivo sincronizado.' });
  } catch (error) {
    console.error('[Push] Error al guardar suscripción:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Eliminar suscripción del dispositivo
app.post('/api/delete-subscription', authMiddleware, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: 'Falta endpoint.' });
  }
  try {
    await Subscription.deleteOne({ endpoint, userId: req.user._id });
    res.status(200).json({ message: 'Dispositivo removido con éxito.' });
  } catch (error) {
    console.error('[Push] Error al eliminar suscripción:', error);
    res.status(500).json({ error: 'Error al eliminar dispositivo.' });
  }
});

// Enviar notificación a todos los dispositivos de un usuario
app.post('/api/send-to-user', authMiddleware, async (req, res) => {
  const { title, body, url } = req.body;
  const userId = req.user._id;

  const payload = JSON.stringify({
    title: title || 'Notificación',
    body: body || 'Tienes un nuevo evento.',
    url: url || '/dashboard',
  });

  try {
    const devices = await Subscription.find({ userId });

    if (devices.length === 0) {
      return res.status(404).json({ message: 'El usuario no tiene dispositivos activos.' });
    }

    const results = await Promise.all(devices.map(async (device) => {
      const pushSubscription = {
        endpoint: device.endpoint,
        expirationTime: device.expirationTime,
        keys: {
          p256dh: device.keys.p256dh,
          auth: device.keys.auth,
        },
      };

      try {
        await webpush.sendNotification(pushSubscription, payload);
        return true;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await Subscription.findByIdAndDelete(device._id);
        } else {
          console.error('[Push] Error enviando a device:', device._id, err.statusCode, err.body || err.message);
        }
        return false;
      }
    }));

    const sentCount = results.filter(Boolean).length;
    if (sentCount === 0) {
      return res.status(502).json({ message: 'No se pudo enviar la notificación a ningún dispositivo.' });
    }
    res.status(200).json({ message: `Enviado a ${sentCount} de ${devices.length} dispositivos.` });
  } catch (error) {
    console.error('[Push] Error global enviando notificaciones:', error);
    res.status(500).json({ error: 'Error al despachar notificaciones.' });
  }
});

// ====== AUDITORÍA + RUTAS GENERALES ======
app.use(auditActivity);
app.use('/api', routes);

// ====== ROOT ======
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

// ====== 404 + errores ======
app.use(notFound);
app.use(errorHandler);

// ====== ARRANQUE ======
connectDB().then(async () => {
  await startMailJobWorker();
  await startAgencyRefreshJobWorker();
  startActivityLogCleanupWorker();

  app.listen(PORT, async () => {
    await logServerEvent('server_started');
    logStartup({
      port: PORT,
      pid: process.pid,
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    });
  });
});