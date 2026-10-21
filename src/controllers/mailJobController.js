const mongoose = require('mongoose');
const { google } = require('googleapis');
const Agency = require('../models/Agency');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const MailJob = require('../models/MailJob');
const Template = require('../models/Template');
const { encryptGoogleToken } = require('../utils/mailJobCrypto');
const { kickMailJobWorker } = require('../services/mailJobWorker');
const { logServerEvent } = require('../utils/serverLogger');
const { mergeEmailLists } = require('../utils/emailList');
const { getFilePeriod } = require('../utils/agencyFileRefreshUtils');

const CODE_TO_KEY = { ANX: 'archivo1', FOR: 'archivo2', REP: 'archivo3', REV: 'archivo4' };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED_GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

function isValidOptionalAttachment(file, year, month) {
  if (!file?.driveId || !Number.isInteger(year) || !Number.isInteger(month)) return false;

  const period = Number.isInteger(file.periodYear) && Number.isInteger(file.periodMonth)
    ? { year: file.periodYear, month: file.periodMonth }
    : getFilePeriod({
      name: file.nombre,
      path: file.path,
      folderPath: file.pseudoPath,
    });
  return period?.year === year && period?.month === month;
}

function resolveAgencyAttachments(agency, template, year, month) {
  const optionalCodes = new Set(template.archivosOpcionales || []);
  const attachments = [];

  for (const code of template.archivosIndividuales || []) {
    const file = agency.archivos?.[CODE_TO_KEY[code]];
    if (optionalCodes.has(code) && !isValidOptionalAttachment(file, year, month)) continue;
    if (!file?.driveId) {
      if (optionalCodes.has(code)) continue;
      throw new Error(`Falta el archivo ${code} para ${agency.nombre}. No se inició el envío.`);
    }
    attachments.push({
      code,
      driveId: file.driveId,
      nombre: file.nombre || `${code}.pdf`,
      ...(optionalCodes.has(code) ? { optional: true } : {}),
    });
  }

  return attachments;
}

function serializeJob(job) {
  return {
    id: String(job._id),
    status: job.status,
    templateName: job.templateName,
    year: job.year,
    month: job.month,
    total: job.total,
    completed: job.completed,
    currentName: job.currentName,
    recipients: job.results,
    error: job.error,
    logError: job.logError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function createMailJob(req, res, next) {
  try {
    const { agencyIds, templateKey, subject, message, year, month, googleAccessToken } = req.body || {};
    if (
      !Array.isArray(agencyIds) || agencyIds.length === 0 || agencyIds.length > 500 ||
      !agencyIds.every((id) => mongoose.isValidObjectId(id)) ||
      typeof templateKey !== 'string' || !templateKey.trim() ||
      typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject) ||
      typeof message !== 'string' || !message.trim() ||
      !Number.isInteger(Number(year)) || Number(year) < 1900 || Number(year) > 2100 ||
      !Number.isInteger(Number(month)) || Number(month) < 1 || Number(month) > 12 ||
      typeof googleAccessToken !== 'string' || !googleAccessToken.trim()
    ) {
      return res.status(400).json({ message: 'Selecciona destinatarios, plantilla, período y autorización válidos.' });
    }

    const existingJob = await MailJob.exists({ owner: req.user._id, status: { $in: ['queued', 'processing'] } });
    if (existingJob) return res.status(409).json({ message: 'Ya tienes un envío en proceso. Espera a que termine antes de iniciar otro.' });

    const oauthClient = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID);
    oauthClient.setCredentials({ access_token: googleAccessToken });
    let profile;
    let scopes;
    try {
      const [profileResponse, tokenInfo] = await Promise.all([
        google.oauth2({ version: 'v2', auth: oauthClient }).userinfo.get(),
        oauthClient.getTokenInfo(googleAccessToken),
      ]);
      profile = profileResponse.data;
      scopes = tokenInfo.scopes || [];
    } catch {
      return res.status(401).json({ message: 'No se pudo validar la autorización de Google. Autoriza Gmail e inténtalo de nuevo.' });
    }

    if (!profile.verified_email || profile.email?.toLowerCase() !== req.user.correo.toLowerCase()) {
      return res.status(403).json({ message: 'La cuenta autorizada de Google debe coincidir con la cuenta de la sesión.' });
    }
    if (!scopes.includes(REQUIRED_GMAIL_SCOPE)) {
      return res.status(403).json({ message: 'Falta el permiso de Gmail para enviar. Autoriza Gmail e inténtalo de nuevo.' });
    }

    const template = await Template.findOne({ key: templateKey.trim().toLowerCase(), activa: true });
    if (!template) return res.status(400).json({ message: 'La plantilla seleccionada ya no está disponible o está inactiva.' });

    const selectedIds = [...new Set(agencyIds.map(String))];
    const agencies = await Agency.find({ _id: { $in: selectedIds } });
    const agenciesById = new Map(agencies.map((agency) => [String(agency._id), agency]));
    if (agenciesById.size !== selectedIds.length) {
      return res.status(400).json({ message: 'Una o más agencias seleccionadas ya no existen. Actualiza la lista e inténtalo de nuevo.' });
    }

    const period = `${Number(year)}-${String(Number(month)).padStart(2, '0')}`;
    const monthlyRecords = await AgencyMonthlyFiles.find({
      agencyId: { $in: selectedIds },
      period,
    }).select('agencyId archivos').lean();
    const filesByAgency = new Map(monthlyRecords.map((record) => [
      String(record.agencyId),
      record.archivos || {},
    ]));
    const orderedAgencies = selectedIds.map((id) => ({
      ...agenciesById.get(id).toObject(),
      archivos: filesByAgency.get(id) || {},
    }));
    const withoutEmail = orderedAgencies.filter((agency) => !EMAIL_PATTERN.test(String(agency.correo || '').trim()));
    if (withoutEmail.length) {
      return res.status(400).json({
        message: `No se inició el envío: ${withoutEmail.map((agency) => agency.nombre).join(', ')} no tiene un correo válido.`,
      });
    }

    const recipients = [];
    for (const agency of orderedAgencies) {
      const errors = {};
      const primaryEmail = agency.correo.trim().toLowerCase();
      const cc = mergeEmailLists([template.cc, agency.cc], 'cc', errors)
        .filter((email) => email !== primaryEmail);
      const cco = mergeEmailLists([template.cco, agency.cco], 'cco', errors)
        .filter((email) => email !== primaryEmail && !cc.includes(email));
      if (Object.keys(errors).length) {
        return res.status(400).json({ message: `Hay direcciones CC/CCO no válidas para ${agency.nombre}.`, errors });
      }
      recipients.push({
        agencyId: String(agency._id),
        agencyName: agency.nombre,
        correo: primaryEmail,
        cc,
        cco,
        attachments: resolveAgencyAttachments(agency, template, Number(year), Number(month)),
      });
    }

    const needsDrive = template.archivosGlobales.length > 0 || recipients.some((recipient) => (
      recipient.attachments.length > 0
    ));
    if (needsDrive && !scopes.includes(REQUIRED_DRIVE_SCOPE)) {
      return res.status(403).json({ message: 'Falta el permiso de lectura de Google Drive para descargar los adjuntos.' });
    }

    const job = await MailJob.create({
      owner: req.user._id,
      ownerEmail: req.user.correo,
      templateKey: template.key,
      templateName: template.nombre,
      year: Number(year),
      month: Number(month),
      subject: subject.trim(),
      message,
      globalAttachments: template.archivosGlobales.map(({ driveId, nombre }) => ({ driveId, nombre })),
      recipients,
      total: recipients.length,
      encryptedGoogleAccessToken: encryptGoogleToken(googleAccessToken),
    });

    await logServerEvent('job_queued', {
      userId: req.user._id,
      jobId: job._id,
      status: job.status,
      total: job.total,
    });
    kickMailJobWorker();
    return res.status(202).json(serializeJob(job));
  } catch (error) {
    if (error.message?.startsWith('Falta el archivo')) return res.status(400).json({ message: error.message });
    return next(error);
  }
}

async function getActiveMailJob(req, res, next) {
  try {
    const job = await MailJob.findOne({ owner: req.user._id, status: { $in: ['queued', 'processing'] } }).sort({ createdAt: -1 });
    return res.json(job ? serializeJob(job) : null);
  } catch (error) {
    return next(error);
  }
}

async function getMailJob(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.jobId)) return res.status(404).json({ message: 'No se encontró el proceso.' });
    const job = await MailJob.findOne({ _id: req.params.jobId, owner: req.user._id });
    if (!job) return res.status(404).json({ message: 'No se encontró el proceso.' });
    return res.json(serializeJob(job));
  } catch (error) {
    return next(error);
  }
}

module.exports = { createMailJob, getActiveMailJob, getMailJob, resolveAgencyAttachments };