const mongoose = require('mongoose');
const ServerEvent = require('../models/ServerEvent');
const ActivityLog = require('../models/ActivityLog');
const Agency = require('../models/Agency');
const Template = require('../models/Template');
const MailLog = require('../models/MailLog');

const RESTORABLE_MODELS = { Agency, Template, MailLog };

async function getActivity(req, res, next) {
  const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return res.status(400).json({ message: 'limit debe ser un número entre 1 y 100.' });
  }
  if (req.query.cursor && !mongoose.isValidObjectId(req.query.cursor)) {
    return res.status(400).json({ message: 'El cursor del historial no es válido.' });
  }

  try {
    const filter = { usuario: req.user._id };
    if (req.query.cursor) filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };

    const results = await ActivityLog.find(filter)
      .sort({ _id: -1 })
      .limit(requestedLimit + 1)
      .select('accion detalle fecha ultimaFecha veces ip usuarioNombre usuarioCorreo')
      .lean();
    const hasMore = results.length > requestedLimit;
    const events = results.slice(0, requestedLimit).map((event) => ({
      id: String(event._id),
      action: event.accion,
      at: event.fecha,
      lastAt: event.ultimaFecha,
      count: event.veces,
      user: { name: event.usuarioNombre, email: event.usuarioCorreo },
      detail: {
        method: event.detalle?.method,
        path: event.detalle?.path,
        statusCode: event.detalle?.statusCode,
        ...(event.detalle?.input ? { inputFields: Object.keys(event.detalle.input) } : {}),
        ...(event.detalle?.recovery ? {
          recovery: {
            entity: event.detalle.recovery.entity,
            available: Boolean(event.detalle.recovery.snapshot) && !event.detalle.recovery.restoredAt,
            restoredAt: event.detalle.recovery.restoredAt,
          },
        } : {}),
      },
    }));

    return res.json({
      events,
      nextCursor: hasMore ? events[events.length - 1].id : null,
    });
  } catch (error) {
    return next(error);
  }
}

async function getActivityById(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'No se encontró la actividad.' });
  }
  try {
    const activity = await ActivityLog.findOne({ _id: req.params.id, usuario: req.user._id })
      .select('-usuario')
      .lean();
    if (!activity) return res.status(404).json({ message: 'No se encontró la actividad.' });
    return res.json(activity);
  } catch (error) {
    return next(error);
  }
}

async function getSystemActivity(req, res, next) {
  const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return res.status(400).json({ message: 'limit debe ser un número entre 1 y 100.' });
  }
  if (req.query.cursor && !mongoose.isValidObjectId(req.query.cursor)) {
    return res.status(400).json({ message: 'El cursor del historial no es válido.' });
  }

  try {
    const filter = {
      $or: [
        { u: req.user._id },
        { u: { $exists: false }, e: 'server_started' },
      ],
    };
    if (req.query.cursor) filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    const results = await ServerEvent.find(filter)
      .sort({ _id: -1 })
      .limit(requestedLimit + 1)
      .select('e j s c n at')
      .lean();
    const hasMore = results.length > requestedLimit;
    const events = results.slice(0, requestedLimit).map((event) => ({
      id: String(event._id),
      type: event.e,
      at: event.at,
      ...(event.j ? { jobId: String(event.j) } : {}),
      ...(event.s ? { status: event.s } : {}),
      ...(event.c != null ? { completed: event.c } : {}),
      ...(event.n != null ? { total: event.n } : {}),
    }));
    return res.json({ events, nextCursor: hasMore ? events[events.length - 1].id : null });
  } catch (error) {
    return next(error);
  }
}

async function restoreActivity(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'No se encontró un respaldo recuperable.' });
  }

  try {
    const activity = await ActivityLog.findOne({ _id: req.params.id, usuario: req.user._id });
    const recovery = activity?.detalle?.recovery;
    if (!recovery?.snapshot || !RESTORABLE_MODELS[recovery.entity]) {
      return res.status(404).json({ message: 'No se encontró un respaldo recuperable.' });
    }
    if (recovery.restoredAt) {
      return res.status(409).json({ message: 'Este registro ya fue restaurado.' });
    }

    const restored = await RESTORABLE_MODELS[recovery.entity].create(recovery.snapshot);
    activity.detalle.recovery.restoredAt = new Date();
    activity.detalle.recovery.restoredBy = String(req.user._id);
    activity.markModified('detalle');
    await activity.save();

    return res.status(201).json({
      restored: true,
      entity: recovery.entity,
      id: String(restored._id),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'No se puede restaurar: ya existe un registro con esos datos únicos.' });
    }
    return next(error);
  }
}

module.exports = { getActivity, getActivityById, getSystemActivity, restoreActivity };