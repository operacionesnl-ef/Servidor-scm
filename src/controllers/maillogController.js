const MailLog = require('../models/Maillog');
const mongoose = require('mongoose');
const { logError } = require('../utils/consoleLogger');

const MAIL_LOG_STATUSES = new Set(['completed', 'completed-with-errors', 'failed']);
const MAX_HISTORY_LIMIT = 100;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseHistoryDate(value, field, endOfDay = false) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: `${field} debe tener formato YYYY-MM-DD.` };
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return { error: `${field} no es una fecha válida.` };
  }
  if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function serializeHistoryLog(log) {
  const recipients = log.recipients || [];
  const totalSent = recipients.filter((recipient) => recipient.status === 'sent').length;
  const totalFailed = recipients.filter((recipient) => recipient.status === 'failed').length;
  const batchStatus = totalSent === 0
    ? 'failed'
    : totalFailed ? 'completed-with-errors' : 'completed';
  return {
    id: String(log._id),
    sentBy: log.sentBy,
    templateKey: log.templateKey,
    templateName: log.templateName,
    year: log.year,
    month: log.month,
    subject: log.asuntoResuelto || '',
    recipientCount: recipients.length,
    totalEnviados: totalSent,
    totalFallidos: totalFailed,
    batchStatus,
    createdAt: log.createdAt,
    recipients: recipients.map((recipient) => ({
      agencyId: String(recipient.agencyId),
      agencyName: recipient.agencyName,
      correo: recipient.correo,
      status: recipient.status,
      error: recipient.error || '',
    })),
  };
}

function serializeHistoryDetail(log) {
  return {
    ...serializeHistoryLog(log),
    message: log.cuerpoResuelto || '',
    archivosGlobales: log.archivosGlobales || [],
    recipients: (log.recipients || []).map((recipient) => ({
      agencyId: String(recipient.agencyId),
      agencyName: recipient.agencyName,
      correo: recipient.correo,
      status: recipient.status,
      gmailMessageId: recipient.gmailMessageId || '',
      error: recipient.error || '',
      attachedFiles: recipient.attachedFiles || [],
    })),
  };
}

/* ────────────────────────────────────────────────────────────
   POST /api/maillogs
   Guarda el resultado de un lote de envíos.
   Body esperado:
   {
     templateKey, templateName,
     year, month,
     asuntoResuelto, cuerpoResuelto,
     archivosGlobales: [{ driveId, nombre }],
     recipients: [
       {
         agencyId, agencyName, correo,
         status: 'sent' | 'failed',
         gmailMessageId?,
         error?,
         attachedFiles: [{ code, driveId, nombre }]
       }
     ]
   }
──────────────────────────────────────────────────────────── */
async function createMailLog(req, res) {
  try {
    const {
      templateKey,
      templateName,
      year,
      month,
      asuntoResuelto,
      cuerpoResuelto,
      archivosGlobales = [],
      recipients = [],
    } = req.body;

    if (!templateKey || !templateName) {
      return res.status(400).json({ error: 'templateKey y templateName son requeridos.' });
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'El campo recipients no puede estar vacío.' });
    }

    const log = new MailLog({
      sentBy:          req.user.correo,
      templateKey,
      templateName,
      year,
      month,
      asuntoResuelto,
      cuerpoResuelto,
      archivosGlobales,
      recipients,
    });

    await log.save();
    res.status(201).json(log);
  } catch (err) {
    logError('No se pudo guardar el historial de envío', err);
    res.status(500).json({ error: err.message || 'No se pudo guardar el log de envío.' });
  }
}

/* ────────────────────────────────────────────────────────────
   GET /api/maillogs
   Lista los lotes del usuario autenticado (paginado).
   Query params: page, limit, templateKey, year, month, batchStatus, search, from, to
──────────────────────────────────────────────────────────── */
async function getMailLogs(req, res) {
  try {
    const {
      page = 1,
      limit = 20,
      templateKey,
      year,
      month,
      batchStatus,
      search,
      from,
      to,
    } = req.query;

    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || parsedPage > 1000000) {
      return res.status(400).json({ message: 'page debe ser un entero positivo.' });
    }
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_HISTORY_LIMIT) {
      return res.status(400).json({ message: `limit debe ser un entero entre 1 y ${MAX_HISTORY_LIMIT}.` });
    }
    if (year !== undefined && (!/^\d{4}$/.test(String(year)) || Number(year) < 1900 || Number(year) > 2100)) {
      return res.status(400).json({ message: 'year debe ser un año entre 1900 y 2100.' });
    }
    if (month !== undefined && (!/^\d{1,2}$/.test(String(month)) || Number(month) < 1 || Number(month) > 12)) {
      return res.status(400).json({ message: 'month debe ser un número entre 1 y 12.' });
    }
    if (batchStatus && !MAIL_LOG_STATUSES.has(batchStatus)) {
      return res.status(400).json({ message: 'batchStatus no es un estado de envío válido.' });
    }
    if (search !== undefined && (typeof search !== 'string' || search.trim().length > 120)) {
      return res.status(400).json({ message: 'search debe contener hasta 120 caracteres.' });
    }
    const fromDate = parseHistoryDate(from, 'from');
    const toDate = parseHistoryDate(to, 'to', true);
    if (fromDate?.error) return res.status(400).json({ message: fromDate.error });
    if (toDate?.error) return res.status(400).json({ message: toDate.error });
    if (fromDate && toDate && fromDate >= toDate) {
      return res.status(400).json({ message: 'from debe ser anterior o igual a to.' });
    }

    const filter = { sentBy: req.user.correo };
    if (templateKey)  filter.templateKey  = templateKey;
    if (batchStatus)  filter.batchStatus  = batchStatus;
    if (year)         filter.year         = Number(year);
    if (month)        filter.month        = Number(month);
    if (fromDate || toDate) {
      filter.createdAt = {
        ...(fromDate ? { $gte: fromDate } : {}),
        ...(toDate ? { $lt: toDate } : {}),
      };
    }
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      const searchPattern = new RegExp(escapeRegex(normalizedSearch), 'i');
      filter.$or = [
        { templateName: searchPattern },
        { templateKey: searchPattern },
        { asuntoResuelto: searchPattern },
        { sentBy: searchPattern },
        { recipients: { $elemMatch: { agencyName: searchPattern } } },
        { recipients: { $elemMatch: { correo: searchPattern } } },
      ];
    }

    const skip  = (parsedPage - 1) * parsedLimit;
    const total = await MailLog.countDocuments(filter);
    const logs  = await MailLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .select('sentBy templateKey templateName year month asuntoResuelto recipients.agencyId recipients.agencyName recipients.correo recipients.status recipients.error totalEnviados totalFallidos batchStatus createdAt');

    return res.json({
      total,
      page: parsedPage,
      limit: parsedLimit,
      pages: Math.ceil(total / parsedLimit),
      data: logs.map(serializeHistoryLog),
    });
  } catch (err) {
    logError('No se pudo listar el historial de envíos', err);
    return res.status(500).json({ message: 'No se pudieron obtener los logs.' });
  }
}

/* ────────────────────────────────────────────────────────────
   GET /api/maillogs/:id
   Detalle completo de un lote (incluye todos los recipients).
──────────────────────────────────────────────────────────── */
async function getMailLogById(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'No se encontró el registro de envío.' });
    }
    const log = await MailLog.findOne({ _id: req.params.id, sentBy: req.user.correo });
    if (!log) return res.status(404).json({ message: 'No se encontró el registro de envío.' });
    return res.json(serializeHistoryDetail(log));
  } catch (err) {
    logError('No se pudo obtener el registro de envío', err);
    return res.status(500).json({ message: 'No se pudo obtener el registro de envío.' });
  }
}

async function getMailLogByJobId(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.jobId)) {
      return res.status(404).json({ error: 'Log no encontrado.' });
    }
    const log = await MailLog.findOne({
      mailJobId: req.params.jobId,
      sentBy: req.user.correo,
    });
    if (!log) return res.status(404).json({ error: 'Log no encontrado.' });
    return res.json(log);
  } catch (err) {
    logError('No se pudo recuperar el historial del envío', err);
    return res.status(500).json({ error: 'No se pudo recuperar el historial del envío.' });
  }
}

/* ────────────────────────────────────────────────────────────
   GET /api/maillogs/agency/:agencyId
   Historial de envíos para una agencia específica.
──────────────────────────────────────────────────────────── */
async function getMailLogsByAgency(req, res) {
  try {
    const { agencyId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    if (!mongoose.isValidObjectId(agencyId)) {
      return res.status(400).json({ message: 'agencyId no es válido.' });
    }
    if (!Number.isInteger(parsedPage) || parsedPage < 1 || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_HISTORY_LIMIT) {
      return res.status(400).json({ message: 'page o limit no son válidos.' });
    }
    const filter = { sentBy: req.user.correo, 'recipients.agencyId': agencyId };
    const skip   = (parsedPage - 1) * parsedLimit;
    const total  = await MailLog.countDocuments(filter);

    const logs = await MailLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .select('templateKey templateName year month asuntoResuelto batchStatus createdAt recipients.$');

    return res.json({ total, page: parsedPage, pages: Math.ceil(total / parsedLimit), data: logs });
  } catch (err) {
    logError('No se pudo obtener el historial de la agencia', err);
    res.status(500).json({ error: err.message || 'No se pudo obtener el historial.' });
  }
}

/* ────────────────────────────────────────────────────────────
   DELETE /api/maillogs/:id
   Elimina un registro (solo admin).
──────────────────────────────────────────────────────────── */
async function deleteMailLog(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Log no encontrado.' });
    }
    if (!['admin', 'developer'].includes(req.user.rol)) {
      return res.status(403).json({ message: 'Se requiere acceso de administrador para eliminar un registro.' });
    }
    const log = await MailLog.findByIdAndDelete(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log no encontrado.' });
    req.auditRecovery = { entity: 'MailLog', snapshot: log.toObject({ depopulate: true }) };
    res.json({ message: 'Log eliminado.', id: req.params.id });
  } catch (err) {
    logError('No se pudo eliminar el registro de envío', err);
    res.status(500).json({ error: err.message || 'No se pudo eliminar el log.' });
  }
}

module.exports = {
  createMailLog,
  getMailLogs,
  getMailLogById,
  getMailLogByJobId,
  getMailLogsByAgency,
  deleteMailLog,
};