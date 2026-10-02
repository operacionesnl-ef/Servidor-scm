const MailLog = require('../models/MailLog');
const mongoose = require('mongoose');

/* ────────────────────────────────────────────────────────────
   POST /api/mail-logs
   Guarda el resultado de un lote de envíos.
   Body esperado:
   {
     sentBy, templateKey, templateName,
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
      sentBy,
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
      sentBy:          sentBy || 'sistema',
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
    console.error('[mailLog] Error al guardar log de envío:', err);
    res.status(500).json({ error: err.message || 'No se pudo guardar el log de envío.' });
  }
}

/* ────────────────────────────────────────────────────────────
   GET /api/mail-logs
   Lista todos los lotes (paginado).
   Query params: page, limit, templateKey, year, month, batchStatus
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
    } = req.query;

    const filter = {};
    if (templateKey)  filter.templateKey  = templateKey;
    if (batchStatus)  filter.batchStatus  = batchStatus;
    if (year)         filter.year         = Number(year);
    if (month)        filter.month        = Number(month);

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await MailLog.countDocuments(filter);
    const logs  = await MailLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      // Excluir cuerpo completo en el listado para reducir payload
      .select('-cuerpoResuelto -recipients.attachedFiles');

    res.json({
      total,
      page:  Number(page),
      pages: Math.ceil(total / Number(limit)),
      data:  logs,
    });
  } catch (err) {
    console.error('[mailLog] Error al listar logs:', err);
    res.status(500).json({ error: err.message || 'No se pudieron obtener los logs.' });
  }
}

/* ────────────────────────────────────────────────────────────
   GET /api/mail-logs/:id
   Detalle completo de un lote (incluye todos los recipients).
──────────────────────────────────────────────────────────── */
async function getMailLogById(req, res) {
  try {
    const log = await MailLog.findById(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log no encontrado.' });
    res.json(log);
  } catch (err) {
    console.error('[mailLog] Error al obtener log:', err);
    res.status(500).json({ error: err.message || 'No se pudo obtener el log.' });
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
    console.error('[mailLog] Error al recuperar el envío:', err);
    return res.status(500).json({ error: 'No se pudo recuperar el historial del envío.' });
  }
}

/* ────────────────────────────────────────────────────────────
   GET /api/mail-logs/agency/:agencyId
   Historial de envíos para una agencia específica.
──────────────────────────────────────────────────────────── */
async function getMailLogsByAgency(req, res) {
  try {
    const { agencyId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const filter = { 'recipients.agencyId': agencyId };
    const skip   = (Number(page) - 1) * Number(limit);
    const total  = await MailLog.countDocuments(filter);

    const logs = await MailLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .select('templateKey templateName year month asuntoResuelto batchStatus createdAt recipients.$');

    res.json({ total, page: Number(page), pages: Math.ceil(total / Number(limit)), data: logs });
  } catch (err) {
    console.error('[mailLog] Error al obtener logs por agencia:', err);
    res.status(500).json({ error: err.message || 'No se pudo obtener el historial.' });
  }
}

/* ────────────────────────────────────────────────────────────
   DELETE /api/mail-logs/:id
   Elimina un registro (solo admin).
──────────────────────────────────────────────────────────── */
async function deleteMailLog(req, res) {
  try {
    const log = await MailLog.findByIdAndDelete(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log no encontrado.' });
    req.auditRecovery = { entity: 'MailLog', snapshot: log.toObject({ depopulate: true }) };
    res.json({ message: 'Log eliminado.', id: req.params.id });
  } catch (err) {
    console.error('[mailLog] Error al eliminar log:', err);
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