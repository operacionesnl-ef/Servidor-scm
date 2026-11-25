const { google } = require('googleapis');
const MailJob = require('../models/MailJob');
const MailLog = require('../models/Maillog');
const { decryptGoogleToken } = require('../utils/mailJobCrypto');
const { buildRawMessage } = require('../utils/gmailMessage');
const { createOrGetPublicDriveCopy, findOrCreateAuxiliaryFolder } = require('./googleDriveService');
const { logConsoleEvent, logServerEvent } = require('../utils/serverLogger');
const { logEvent } = require('../utils/consoleLogger');
const { sendPushToUser } = require('./pushNotificationService');
const { shouldPauseMailJobs } = require('./resourceMonitor');

const GOOGLE_EXPORT_TYPES = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'image/png',
};
const MAX_DIRECT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_GMAIL_RAW_BYTES = 25 * 1024 * 1024;
const RESOURCE_RESUME_POLL_MS = 5000;

let workerPromise = null;
let pollTimer = null;

function assertGmailRawMessageSize(raw) {
  assertGmailRawMessageBytes(Buffer.from(raw, 'base64url').length);
}

function assertGmailRawMessageBytes(messageBytes) {
  if (messageBytes > MAX_GMAIL_RAW_BYTES) {
    throw new Error('El correo excede el límite de tamaño que acepta Gmail después de codificar los adjuntos. Reduce el tamaño de los archivos o envíalos mediante un enlace de Google Drive.');
  }
}

function getResumableRecipientIndexes(job) {
  const indexes = [];
  for (let index = 0; index < job.recipients.length; index += 1) {
    const result = job.results[index];
    if (
      result?.status === 'cancelled' ||
      result?.status === 'pending' ||
      (result?.status === 'failed' && result.retryable)
    ) indexes.push(index);
  }
  return indexes;
}

function classifySendFailure(error, sendStarted) {
  if (!sendStarted) return { status: 'failed', retryable: true };
  const statusCode = Number(error?.response?.status || error?.code);
  const definitelyRejected = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500;
  return definitelyRejected
    ? { status: 'failed', retryable: true }
    : { status: 'unknown', retryable: false };
}

async function buildRawMessageWithinLimit(drive, { to, cc, cco, subject, message, preparedAttachments }) {
  const attachments = preparedAttachments.filter((attachment) => attachment.content);
  const driveLinks = preparedAttachments.filter((attachment) => attachment.driveLink);
  while (true) {
    const linkText = driveLinks.length
      ? `\n\nArchivos disponibles en Google Drive:\n${driveLinks.map((file) => `${file.nombre}: ${file.driveLink}`).join('\n')}`
      : '';
    const raw = buildRawMessage({
      to,
      cc,
      cco,
      subject,
      text: message + linkText,
      attachments,
    });
    if (Buffer.from(raw, 'base64url').length <= MAX_GMAIL_RAW_BYTES) {
      return { raw, preparedAttachments };
    }
    if (!attachments.length) assertGmailRawMessageSize(raw);

    const attachment = attachments.pop();
    const auxiliaryFolder = await findOrCreateAuxiliaryFolder(drive);
    const copy = await createOrGetPublicDriveCopy(drive, {
      sourceDriveId: attachment.driveId,
      folderId: auxiliaryFolder.id,
      fileName: attachment.nombre,
    });
    const driveLink = {
      nombre: copy.name || attachment.nombre,
      driveId: copy.id,
      driveLink: copy.webViewLink,
      code: attachment.code,
    };
    driveLinks.push(driveLink);
    const preparedIndex = preparedAttachments.indexOf(attachment);
    preparedAttachments[preparedIndex] = driveLink;
  }
}

function resolveText(text, { month, year, agencyName }) {
  const months = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return String(text || '')
    .replace(/\{\{MES\}\}/g, months[month] || '')
    .replace(/\{\{AÑO\}\}/g, String(year))
    .replace(/\{\{SUCURSAL\}\}/g, agencyName);
}

async function readDriveFile(drive, file, maxBytes = MAX_DIRECT_ATTACHMENT_BYTES) {
  const { data: metadata } = await drive.files.get({
    fileId: file.driveId,
    fields: 'id,name,mimeType,size',
    supportsAllDrives: true,
  });
  const isNativeFile = metadata.mimeType?.startsWith('application/vnd.google-apps.');
  const exportType = GOOGLE_EXPORT_TYPES[metadata.mimeType];
  if (isNativeFile && !exportType) throw new Error(`El archivo ${metadata.name} no se puede adjuntar en este formato.`);
  const nombre = file.nombre || metadata.name;
  const mimeType = isNativeFile ? exportType : metadata.mimeType || 'application/octet-stream';
  if (maxBytes <= 0 || (!isNativeFile && Number(metadata.size) > maxBytes)) {
    return { nombre, mimeType, content: null };
  }

  const response = isNativeFile
    ? await drive.files.export({ fileId: file.driveId, mimeType: exportType }, { responseType: 'stream' })
    : await drive.files.get({ fileId: file.driveId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.data) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      response.data.destroy?.();
      return { nombre, mimeType, content: null };
    }
    chunks.push(buffer);
  }

  return { nombre, mimeType, content: Buffer.concat(chunks) };
}

async function buildAttachments(drive, recipient, globalAttachments) {
  const files = [...recipient.attachments, ...globalAttachments]
    .sort((left, right) => Number(Boolean(left.optional)) - Number(Boolean(right.optional)));
  const attachments = [];
  let totalBytes = 0;
  let auxiliaryFolderId = null;
  for (const file of files) {
    let attachment;
    try {
      attachment = await readDriveFile(
        drive,
        file,
        MAX_DIRECT_ATTACHMENT_BYTES - totalBytes,
      );
      if (!attachment.content) {
        if (!auxiliaryFolderId) {
          const folder = await findOrCreateAuxiliaryFolder(drive);
          auxiliaryFolderId = folder.id;
        }
        const copy = await createOrGetPublicDriveCopy(drive, {
          sourceDriveId: file.driveId,
          folderId: auxiliaryFolderId,
          fileName: attachment.nombre,
        });
        attachments.push({
          nombre: copy.name || attachment.nombre,
          driveId: copy.id,
          driveLink: copy.webViewLink,
          code: file.code,
        });
        continue;
      }
    } catch (error) {
      if (!file.optional) throw error;
      logEvent('mail_optional_attachment_omitted', {
        agency: recipient.agencyName,
        code: file.code,
        driveId: file.driveId,
        reason: error.message || 'No se pudo preparar el archivo opcional.',
      });
      continue;
    }

    totalBytes += attachment.content.length;
    attachments.push({ ...attachment, code: file.code, driveId: file.driveId });
  }
  return attachments;
}

async function recordMailLog(job) {
  const asuntoResuelto = resolveText(job.subject, { month: job.month, year: job.year, agencyName: '[SUCURSAL]' });
  const cuerpoResuelto = resolveText(job.message, { month: job.month, year: job.year, agencyName: '[SUCURSAL]' });
  const recipients = job.recipients.map((recipient, index) => {
    const result = job.results[index] || {};
    return {
      agencyId: recipient.agencyId,
      agencyName: recipient.agencyName,
      correo: recipient.correo,
      cc: recipient.cc || [],
      cco: recipient.cco || [],
      status: ['sent', 'failed', 'unknown', 'cancelled'].includes(result.status)
        ? result.status
        : 'cancelled',
      retryable: Boolean(result.retryable),
      gmailMessageId: result.gmailMessageId,
      error: result.error,
      attachedFiles: (result.attachedFiles || []).filter((file) => file.code),
    };
  });
  const values = {
    mailJobId: job._id,
    mailJobStatus: job.status,
    sentBy: job.ownerEmail,
    templateKey: job.templateKey,
    templateName: job.templateName,
    year: job.year,
    month: job.month,
    asuntoResuelto,
    cuerpoResuelto,
    archivosGlobales: job.globalAttachments,
    recipients,
  };
  const log = await MailLog.findOne({ mailJobId: job._id }) || new MailLog();
  Object.assign(log, values);
  await log.save();
  return log._id;
}

async function finishJob(job, status, error = '', event = 'job_finished') {
  for (let index = 0; index < job.recipients.length; index += 1) {
    const recipient = job.recipients[index];
    const result = job.results[index]?.toObject?.() || job.results[index] || {};
    const common = {
      agencyId: recipient.agencyId,
      agencyName: recipient.agencyName,
      correo: recipient.correo,
      cc: recipient.cc || [],
      cco: recipient.cco || [],
      attachedFiles: result.attachedFiles || [],
      ...result,
    };

    if (result.status === 'sending') {
      job.results[index] = {
        ...common,
        status: 'unknown',
        retryable: false,
        error: 'No se pudo confirmar si Gmail aceptó este mensaje. No se reenviará para evitar duplicados; revisa Elementos enviados.',
      };
    } else if (result.status === 'preparing') {
      job.results[index] = {
        ...common,
        status: 'failed',
        retryable: true,
        error: error || 'El servidor se detuvo antes de iniciar el envío a Gmail.',
      };
    } else if (!result.status || result.status === 'pending') {
      job.results[index] = {
        ...common,
        status: 'cancelled',
        retryable: false,
        error: 'No se procesó porque el proceso se detuvo antes de enviar este correo.',
        attachedFiles: [],
      };
    }
  }

  job.status = status;
  job.error = error;
  job.currentName = '';
  job.completed = job.recipients.length;
  job.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  try {
    job.mailLogId = await recordMailLog(job);
  } catch (logError) {
    job.logError = logError.message || 'No se pudo guardar el historial del envío.';
  }

  await job.save();
  try {
    await sendPushToUser(job.owner, {
      title: status === 'completed' ? 'Envío de correos completado' : 'El envío de correos tuvo un problema',
      body: `${job.completed} de ${job.total} correos procesados${error ? `: ${error}` : '.'}`,
      url: '/historial-correos',
      tag: `mail-job-${job._id}`,
    });
  } catch (pushError) {
    logEvent('mail_job_push_failed', { jobId: String(job._id), message: pushError.message });
  }
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

    for (let index = 0; index < job.recipients.length; index += 1) {
      const previous = job.results[index];
      const shouldProcess = !previous
        || previous.status === 'pending'
        || previous.status === 'cancelled'
        || (previous.status === 'failed' && previous.retryable);
      if (!shouldProcess) continue;

      const recipient = job.recipients[index];
      job.currentIndex = index;
      job.currentName = recipient.agencyName;
      job.results[index] = {
        agencyId: recipient.agencyId,
        agencyName: recipient.agencyName,
        correo: recipient.correo,
        cc: recipient.cc || [],
        cco: recipient.cco || [],
        status: 'pending',
        retryable: false,
        attachedFiles: [],
      };
      await job.save();

      while (shouldPauseMailJobs()) {
        await new Promise((resolve) => setTimeout(resolve, RESOURCE_RESUME_POLL_MS));
      }

      job.results[index].status = 'preparing';
      await job.save();

      let result;
      let sendStarted = false;
      let attachedFiles = [];
      try {
        const preparedAttachments = await buildAttachments(drive, recipient, job.globalAttachments);
        const subject = resolveText(job.subject, { month: job.month, year: job.year, agencyName: recipient.agencyName });
        const message = resolveText(job.message, { month: job.month, year: job.year, agencyName: recipient.agencyName });
        const { raw, preparedAttachments: finalPreparedAttachments } = await buildRawMessageWithinLimit(drive, {
          to: recipient.correo,
          cc: recipient.cc,
          cco: recipient.cco,
          subject,
          message,
          preparedAttachments,
        });
        attachedFiles = finalPreparedAttachments
          .map(({ code, driveId, nombre }) => ({ code, driveId, nombre }))
          .filter((file) => file.code);
        finalPreparedAttachments.forEach((attachment) => { attachment.content = null; });
        job.results[index] = {
          ...job.results[index].toObject(),
          status: 'sending',
          retryable: false,
        };
        await job.save();
        sendStarted = true;
        const { data } = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });
        result = {
          agencyId: recipient.agencyId,
          agencyName: recipient.agencyName,
          correo: recipient.correo,
          cc: recipient.cc,
          cco: recipient.cco,
          status: 'sent',
          gmailMessageId: data.id || '',
          attachedFiles,
        };
      } catch (error) {
        const disposition = classifySendFailure(error, sendStarted);
        result = {
          agencyId: recipient.agencyId,
          agencyName: recipient.agencyName,
          correo: recipient.correo,
          cc: recipient.cc,
          cco: recipient.cco,
          ...disposition,
          error: disposition.status === 'unknown'
            ? `No se pudo confirmar si Gmail aceptó este mensaje. No se reenviará para evitar duplicados; revisa Elementos enviados.${error.message ? ` Detalle: ${error.message}` : ''}`
            : error.message || 'No se pudo preparar el correo antes de enviarlo.',
          attachedFiles: disposition.status === 'unknown' ? attachedFiles : [],
        };
      }

      job.results[index] = result;
      job.completed = job.results.filter((item) => ['sent', 'failed', 'unknown'].includes(item.status)).length;
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
      if (result.status === 'failed' || result.status === 'unknown') {
        await finishJob(job, 'failed', result.error);
        return;
      }
    }

    const unresolvedDelivery = job.results.some((result) => (
      result.status === 'unknown' || (result.status === 'failed' && !result.retryable)
    ));
    await finishJob(
      job,
      unresolvedDelivery ? 'failed' : 'completed',
      unresolvedDelivery
        ? 'El proceso continuó sin reenviar correos cuyo resultado no se pudo confirmar. Revisa esos mensajes en Elementos enviados.'
        : '',
    );
  } catch (error) {
    const message = error.message || 'El proceso no pudo continuar.';
    await finishJob(job, 'failed', message);
  }
}

async function recoverInterruptedJobs() {
  const interrupted = await MailJob.find({ status: 'processing' }).select('+encryptedGoogleAccessToken');
  for (const job of interrupted) {
    const message = 'El servidor se reinició durante el envío. Los mensajes con resultado incierto no se reenviarán para evitar duplicados; los demás destinatarios se pueden continuar desde el historial.';
    const firstUnrecordedIndex = job.results.length < job.recipients.length
      ? job.results.length
      : -1;
    const legacyUnresolvedIndex = firstUnrecordedIndex === job.currentIndex
      ? firstUnrecordedIndex
      : -1;
    for (let index = 0; index < job.results.length; index += 1) {
      const result = job.results[index];
      if (result?.status === 'sending') {
        job.results[index] = {
          ...result.toObject(),
          status: 'unknown',
          retryable: false,
          error: 'El servidor se reinició durante el envío. Revisa Elementos enviados; este correo no se reenviará automáticamente.',
        };
      }
    }
    if (legacyUnresolvedIndex >= 0 && !job.results[legacyUnresolvedIndex]) {
      const recipient = job.recipients[legacyUnresolvedIndex];
      job.results[legacyUnresolvedIndex] = {
        agencyId: recipient.agencyId,
        agencyName: recipient.agencyName,
        correo: recipient.correo,
        cc: recipient.cc || [],
        cco: recipient.cco || [],
        status: 'unknown',
        retryable: false,
        error: 'El resultado no se pudo confirmar tras reiniciar el servidor. Revisa Elementos enviados antes de actuar.',
        attachedFiles: [],
      };
    }
    await finishJob(job, 'failed', message, 'job_recovered');
  }
}

async function processQueuedJobs() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (true) {
      if (shouldPauseMailJobs()) break;
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

module.exports = {
  assertGmailRawMessageBytes,
  assertGmailRawMessageSize,
  buildAttachments,
  buildRawMessageWithinLimit,
  classifySendFailure,
  readDriveFile,
  recordMailLog,
  finishJob,
  getResumableRecipientIndexes,
  startMailJobWorker,
  kickMailJobWorker,
};