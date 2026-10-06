const { google } = require('googleapis');
const MailJob = require('../models/MailJob');
const MailLog = require('../models/Maillog');
const { decryptGoogleToken } = require('../utils/mailJobCrypto');
const { buildRawMessage } = require('../utils/gmailMessage');
const { logConsoleEvent, logServerEvent } = require('../utils/serverLogger');
const { logEvent } = require('../utils/consoleLogger');

const GOOGLE_EXPORT_TYPES = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'image/png',
};
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

let workerPromise = null;
let pollTimer = null;

function resolveText(text, { month, year, agencyName }) {
  const months = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return String(text || '')
    .replace(/\{\{MES\}\}/g, months[month] || '')
    .replace(/\{\{AÑO\}\}/g, String(year))
    .replace(/\{\{SUCURSAL\}\}/g, agencyName);
}

async function readDriveFile(drive, file) {
  const { data: metadata } = await drive.files.get({
    fileId: file.driveId,
    fields: 'id,name,mimeType,size',
    supportsAllDrives: true,
  });
  const isNativeFile = metadata.mimeType?.startsWith('application/vnd.google-apps.');
  const exportType = GOOGLE_EXPORT_TYPES[metadata.mimeType];
  if (isNativeFile && !exportType) throw new Error(`El archivo ${metadata.name} no se puede adjuntar en este formato.`);

  const response = isNativeFile
    ? await drive.files.export({ fileId: file.driveId, mimeType: exportType }, { responseType: 'stream' })
    : await drive.files.get({ fileId: file.driveId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.data) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_ATTACHMENT_BYTES) throw new Error(`El archivo ${metadata.name} supera el límite de 40 MB.`);
    chunks.push(buffer);
  }

  return {
    nombre: file.nombre || metadata.name,
    mimeType: isNativeFile ? exportType : metadata.mimeType || 'application/octet-stream',
    content: Buffer.concat(chunks),
  };
}

async function buildAttachments(drive, recipient, globalAttachments) {
  const files = [...recipient.attachments, ...globalAttachments];
  const attachments = [];
  let totalBytes = 0;
  for (const file of files) {
    const attachment = await readDriveFile(drive, file);
    totalBytes += attachment.content.length;
    if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error('Los adjuntos superan el límite total de 40 MB.');
    attachments.push({ ...attachment, code: file.code, driveId: file.driveId });
  }
  return attachments;
}

async function recordMailLog(job) {
  const asuntoResuelto = resolveText(job.subject, { month: job.month, year: job.year, agencyName: '[SUCURSAL]' });
  const cuerpoResuelto = resolveText(job.message, { month: job.month, year: job.year, agencyName: '[SUCURSAL]' });
  const recipients = job.results.map((result) => ({
    agencyId: result.agencyId,
    agencyName: result.agencyName,
    correo: result.correo,
    status: result.status === 'sent' ? 'sent' : 'failed',
    gmailMessageId: result.gmailMessageId,
    error: result.error,
    attachedFiles: result.attachedFiles.filter((file) => file.code),
  }));
  const log = await MailLog.create({
    mailJobId: job._id,
    sentBy: job.ownerEmail,
    templateKey: job.templateKey,
    templateName: job.templateName,
    year: job.year,
    month: job.month,
    asuntoResuelto,
    cuerpoResuelto,
    archivosGlobales: job.globalAttachments,
    recipients,
  });
  return log._id;
}

async function finishJob(job, status, error = '', event = 'job_finished') {
  const remaining = job.recipients.slice(job.results.length);
  if (remaining.length) {
    const isFirstUnresolvedFailure = status === 'failed' && job.results.length === 0;
    remaining.forEach((recipient, index) => {
      const failed = isFirstUnresolvedFailure && index === 0;
      job.results.push({
        agencyId: recipient.agencyId,
        agencyName: recipient.agencyName,
        correo: recipient.correo,
        status: failed ? 'failed' : 'cancelled',
        error: failed ? error : 'Cancelado porque el proceso no pudo continuar.',
        attachedFiles: [],
      });
    });
  }

  try {
    if (!job.mailLogId) job.mailLogId = await recordMailLog(job);
  } catch (logError) {
    job.logError = logError.message || 'No se pudo guardar el historial del envío.';
  }

  job.status = status;
  job.error = error;
  job.currentName = '';
  job.completed = job.recipients.length;
  job.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await job.save();
  await logServerEvent(event, {
    userId: job.owner,
    jobId: job._id,
    status,
    completed: job.completed,
    total: job.total,
  });
}

async function processJob(job) {
  try {
    const accessToken = decryptGoogleToken(job.encryptedGoogleAccessToken);
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID);
    auth.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    for (let index = job.completed; index < job.recipients.length; index += 1) {
      const recipient = job.recipients[index];
      job.currentIndex = index;
      job.currentName = recipient.agencyName;
      await job.save();

      let result;
      try {
        const attachments = await buildAttachments(drive, recipient, job.globalAttachments);
        const subject = resolveText(job.subject, { month: job.month, year: job.year, agencyName: recipient.agencyName });
        const text = resolveText(job.message, { month: job.month, year: job.year, agencyName: recipient.agencyName });
        const { data } = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: buildRawMessage({ to: recipient.correo, subject, text, attachments }) },
        });
        result = {
          agencyId: recipient.agencyId,
          agencyName: recipient.agencyName,
          correo: recipient.correo,
          status: 'sent',
          gmailMessageId: data.id || '',
          attachedFiles: attachments.map(({ code, driveId, nombre }) => ({ code, driveId, nombre })).filter((file) => file.code),
        };
      } catch (error) {
        result = {
          agencyId: recipient.agencyId,
          agencyName: recipient.agencyName,
          correo: recipient.correo,
          status: 'failed',
          error: error.message || 'No se pudo enviar el correo.',
          attachedFiles: [],
        };
      }

      job.results.push(result);
      job.completed = index + 1;
      job.currentIndex = index + 1;
      await job.save();
      logConsoleEvent('mail_job.recipient', {
        jobId: String(job._id),
        ownerEmail: job.ownerEmail,
        agency: recipient.agencyName,
        status: result.status,
        completed: job.completed,
        total: job.total,
        ...(result.error ? { error: result.error.slice(0, 300) } : {}),
      });
      if (result.status === 'failed') {
        await finishJob(job, 'failed', result.error);
        return;
      }
    }

    await finishJob(job, 'completed');
  } catch (error) {
    const message = error.message || 'El proceso no pudo continuar.';
    if (job.currentIndex < job.recipients.length && job.results.length === job.currentIndex) {
      const recipient = job.recipients[job.currentIndex];
      job.results.push({
        agencyId: recipient.agencyId,
        agencyName: recipient.agencyName,
        correo: recipient.correo,
        status: 'failed',
        error: message,
        attachedFiles: [],
      });
    }
    await finishJob(job, 'failed', message);
  }
}

async function recoverInterruptedJobs() {
  const interrupted = await MailJob.find({ status: 'processing' }).select('+encryptedGoogleAccessToken');
  for (const job of interrupted) {
    const message = 'El servidor se reinició durante el envío; se cancelaron los destinatarios restantes para evitar duplicados.';
    const unresolved = job.recipients[job.results.length];
    if (unresolved) {
      job.results.push({
        agencyId: unresolved.agencyId,
        agencyName: unresolved.agencyName,
        correo: unresolved.correo,
        status: 'failed',
        error: 'El resultado de este envío no se pudo confirmar tras reiniciar el servidor.',
        attachedFiles: [],
      });
    }
    await finishJob(job, 'failed', message, 'job_recovered');
  }
}

async function processQueuedJobs() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (true) {
      const job = await MailJob.findOneAndUpdate(
        { status: 'queued' },
        { $set: { status: 'processing' } },
        { sort: { createdAt: 1 }, new: true }
      ).select('+encryptedGoogleAccessToken');
      if (!job) break;
      await logServerEvent('job_started', {
        userId: job.owner,
        jobId: job._id,
        status: job.status,
        total: job.total,
      });
      await processJob(job);
    }
  })().finally(() => { workerPromise = null; });
  return workerPromise;
}

async function startMailJobWorker() {
  await recoverInterruptedJobs();
  kickMailJobWorker();
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      processQueuedJobs().catch((error) => logEvent('mail_job_worker_failed', { message: error.message }));
    }, 1500);
    pollTimer.unref?.();
  }
}

function kickMailJobWorker() {
  processQueuedJobs().catch((error) => logEvent('mail_job_worker_failed', { message: error.message }));
}

module.exports = { startMailJobWorker, kickMailJobWorker };