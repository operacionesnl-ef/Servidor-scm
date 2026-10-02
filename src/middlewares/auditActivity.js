const { createHash } = require('node:crypto');
const ActivityLog = require('../models/ActivityLog');
const { createRecoverySnapshot, sanitizeAuditValue } = require('../utils/auditSanitizer');

function auditActivity(req, res, next) {
  const startedAt = Date.now();
  const originalJson = res.json.bind(res);
  let responseHandled = false;

  res.json = (responseBody) => {
    if (responseHandled) return originalJson(responseBody);
    responseHandled = true;

    const finishedAt = new Date();
    const method = req.method;
    const path = `${req.baseUrl}${req.path}`;
    const user = req.user;
    const readOnly = method === 'GET' || method === 'HEAD';
    const safeRequestData = sanitizeAuditValue(readOnly ? req.query : req.body || {});
    const entry = {
      timestamp: finishedAt.toISOString(),
      user: user
        ? { id: String(user._id), nombre: user.nombre, correo: user.correo, status: user.status }
        : null,
      method,
      path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      data: safeRequestData,
    };

    const sendResponse = () => {
      console.info(JSON.stringify(entry));
      return originalJson(responseBody);
    };

    if (!user || (path.startsWith('/api/activity') && readOnly)) return sendResponse();

    const detail = {
      method,
      path,
      statusCode: res.statusCode,
      ...(readOnly ? { query: safeRequestData } : { input: safeRequestData }),
    };
    if (req.auditRecovery) {
      const snapshot = createRecoverySnapshot(req.auditRecovery.snapshot);
      detail.recovery = {
        entity: req.auditRecovery.entity,
        snapshot,
        unavailable: snapshot === null,
      };
    }

    const action = `${method} ${path}`;
    const logEntry = {
      usuario: user._id,
      usuarioNombre: user.nombre,
      usuarioCorreo: user.correo,
      accion: action,
      detalle: detail,
      fecha: finishedAt,
      ultimaFecha: finishedAt,
      veces: 1,
      ip: req.ip,
      expiresAt: new Date(finishedAt.getTime() + getRetentionMs()),
    };

    const persistActivity = async () => {
      if (readOnly) {
        const coalesceKey = createHash('sha256')
          .update(JSON.stringify({ query: safeRequestData, statusCode: res.statusCode }))
          .digest('hex');
        const existing = await ActivityLog.findOneAndUpdate(
          {
            usuario: user._id,
            accion: action,
            coalesceKey,
            ultimaFecha: { $gte: new Date(finishedAt.getTime() - 60_000) },
          },
          {
            $inc: { veces: 1 },
            $set: { ultimaFecha: finishedAt, ip: req.ip, expiresAt: logEntry.expiresAt },
          },
          { sort: { ultimaFecha: -1 }, new: true }
        );
        if (existing) return;
        logEntry.coalesceKey = coalesceKey;
      }
      await ActivityLog.create(logEntry);
    };

    return persistActivity().then(sendResponse).catch(() => {
      console.error(JSON.stringify({ timestamp: finishedAt.toISOString(), event: 'activity_log_failed' }));
      return sendResponse();
    });
  };

  return next();
}

function getRetentionMs() {
  const configuredDays = Number(process.env.ACTIVITY_LOG_RETENTION_DAYS || 365);
  const days = Number.isInteger(configuredDays) && configuredDays > 0 ? configuredDays : 365;
  return days * 24 * 60 * 60 * 1000;
}

module.exports = auditActivity;