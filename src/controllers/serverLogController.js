const mongoose = require('mongoose');
const ServerEvent = require('../models/ServerEvent');
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');

async function getServerLogs(req, res, next) {
  const source = req.query.source || 'activity';
  if (!['activity', 'events'].includes(source)) {
    return res.status(400).json({ success: false, message: 'source must be activity or events' });
  }
  const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return res.status(400).json({ success: false, message: 'limit must be between 1 and 100' });
  }
  if (req.query.cursor && !mongoose.isValidObjectId(req.query.cursor)) {
    return res.status(400).json({ success: false, message: 'Invalid cursor' });
  }

  try {
    const filter = {};
    if (req.query.cursor) filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    if (source === 'activity') {
      const results = await ActivityLog.find(filter)
        .sort({ _id: -1 })
        .limit(requestedLimit + 1)
        .select('accion detalle fecha ultimaFecha veces usuarioNombre usuarioCorreo')
        .lean();
      const hasMore = results.length > requestedLimit;
      const events = results.slice(0, requestedLimit).map((entry) => ({
        id: String(entry._id),
        type: 'request',
        action: entry.accion,
        at: entry.fecha,
        lastAt: entry.ultimaFecha,
        count: entry.veces,
        actor: { name: entry.usuarioNombre, email: entry.usuarioCorreo },
        detail: {
          method: entry.detalle?.method,
          path: entry.detalle?.path,
          statusCode: entry.detalle?.statusCode,
        },
      }));
      return res.json({
        events,
        nextCursor: hasMore ? events[events.length - 1].id : null,
      });
    }

    const results = await ServerEvent.find(filter)
      .sort({ _id: -1 })
      .limit(requestedLimit + 1)
      .select('e j s c n at u')
      .lean();
    const hasMore = results.length > requestedLimit;
    const page = results.slice(0, requestedLimit);
    const userIds = [...new Set(page.map((event) => event.u && String(event.u)).filter(Boolean))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('nombre correo').lean()
      : [];
    const usersById = new Map(users.map((user) => [String(user._id), {
      name: user.nombre,
      email: user.correo,
    }]));
    const events = page.map((event) => ({
      id: String(event._id),
      type: event.e,
      at: event.at,
      ...(event.u ? { actor: usersById.get(String(event.u)) || null } : {}),
      ...(event.j ? { jobId: String(event.j) } : {}),
      ...(event.s ? { status: event.s } : {}),
      ...(event.c != null ? { completed: event.c } : {}),
      ...(event.n != null ? { total: event.n } : {}),
    }));

    return res.json({
      events,
      nextCursor: hasMore ? events[events.length - 1].id : null,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getServerLogs };