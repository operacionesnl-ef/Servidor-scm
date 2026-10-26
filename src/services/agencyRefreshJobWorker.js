'use strict';

const { google } = require('googleapis');
const Agency = require('../models/Agency');
const AgencyRefreshJob = require('../models/AgencyRefreshJob');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const Notification = require('../models/Notification');
const { decryptGoogleToken } = require('../utils/mailJobCrypto');
const {
  FILE_TYPES,
  getAgencyFileRequirementPolicy,
} = require('../utils/agencyFileRefreshUtils');
const { refreshAgencyFromDrive } = require('./agencyDriveRefresh');
const { inspectAgencyIntegrity } = require('./agencyIntegrityCheck');
const { logServerEvent } = require('../utils/serverLogger');
const { logEvent } = require('../utils/consoleLogger');
const { sendPushToUser } = require('./pushNotificationService');

let workerPromise = null;
let pollTimer = null;

function isVerifiedForPeriod(agency, year, month, archivos = agency.archivos) {
  const policy = getAgencyFileRequirementPolicy(agency, archivos);
  if (!policy.requirementSatisfied) return false;
  return FILE_TYPES.every(({ key }) => {
    const file = archivos?.[key];
    if (!file?.driveId) return true;
    return Boolean(
      file.periodYear === year &&
      file.periodMonth === month
    );
  });
}

async function processJob(job) {
  const accessToken = decryptGoogleToken(job.encryptedGoogleAccessToken);
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID);
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth });
  const processName = job.jobType === 'integrity' ? 'Verificación' : 'Actualización';

  for (const agencyId of job.agencyIds.slice(job.completed)) {
    const agency = await Agency.findById(agencyId);
    const agencyName = agency?.nombre || agencyId;
    logEvent('agency_job_agency_started', {
      jobId: String(job._id),
      ownerEmail: job.ownerEmail,
      agency: agencyName,
      completed: job.completed,
      total: job.total,
      status: 'processing',
      message: `${processName} de archivos`,
    });

    if (!agency) {
      job.results.push({
        agencyId,
        agencyName: agencyId,
        correo: '',
        entidadFederativa: '',
        status: 'failed',
        missingKeys: FILE_TYPES.map(({ key }) => key),
        error: 'La agencia ya no existe.',
      });
      job.completed += 1;
      await job.save();
      logEvent('agency_job_progress', {
        jobId: String(job._id),
        ownerEmail: job.ownerEmail,
        agency: agencyName,
        completed: job.completed,
        total: job.total,
        status: 'failed',
        message: 'La agencia ya no existe.',
      });
      continue;
    }

    const period = `${job.year}-${String(job.month).padStart(2, '0')}`;
    const monthlyRecord = await AgencyMonthlyFiles.findOne({
      agencyId: agency._id,
      period,
    }).lean();
    const periodFiles = monthlyRecord?.archivos || {};

    if (job.jobType === 'refresh' && isVerifiedForPeriod(agency, job.year, job.month, periodFiles)) {
      job.results.push({
        agencyId: String(agency._id),
        agencyName: agency.nombre,
        period,
        correo: agency.correo,
        entidadFederativa: agency.entidadFederativa,
        agencyStatus: agency.status || 'activa',
        status: 'skipped',
        missingKeys: [],
        files: periodFiles,
        checks: [],
      });
      job.completed += 1;
      await job.save();
      logEvent('agency_job_progress', {
        jobId: String(job._id),
        ownerEmail: job.ownerEmail,
        agency: agency.nombre,
        completed: job.completed,
        total: job.total,
        status: 'skipped',
      });
      continue;
    }

    job.currentName = agency.nombre;
    await job.save();

    try {
      const periodAgency = agency.toObject();
      periodAgency.archivos = periodFiles;
      const update = job.jobType === 'integrity'
        ? await inspectAgencyIntegrity(drive, periodAgency, { year: job.year, month: job.month })
        : await refreshAgencyFromDrive(agency, drive, job.year, job.month);
      const policy = getAgencyFileRequirementPolicy(agency, update.archivos || periodFiles);
      const missingKeys = job.jobType === 'integrity'
        ? update.missingKeys
        : policy.missingKeys;
      job.results.push({
        agencyId: String(agency._id),
        agencyName: agency.nombre,
        period: update.period
          ? `${update.period.year}-${String(update.period.month).padStart(2, '0')}`
          : period,
        correo: agency.correo,
        entidadFederativa: agency.entidadFederativa,
        agencyStatus: agency.status || 'activa',
        carpetaPrincipal: agency.archivos?.carpetaPrincipal || '',
        status: update.status === 'issues' || missingKeys.length ? 'issues' : 'updated',
        missingKeys,
        optionalMissingKeys: update.optionalMissingKeys || policy.optionalMissingKeys,
        notices: update.notices || (policy.optionalMessage ? [policy.optionalMessage] : []),
        files: update.archivos || periodFiles,
        checks: update.checks || [],
      });
      job.scannedFiles += update.scannedFiles || update.checks?.length || 0;
    } catch (error) {
      if (Number(error.code || error.response?.status) === 401) throw error;
      job.results.push({
        agencyId: String(agency._id),
        agencyName: agency.nombre,
        period,
        correo: agency.correo,
        entidadFederativa: agency.entidadFederativa,
        agencyStatus: agency.status || 'activa',
        carpetaPrincipal: agency.archivos?.carpetaPrincipal || '',
        status: 'failed',
        missingKeys: FILE_TYPES.map(({ key }) => key),
        files: periodFiles,
        checks: [],
        error: error.message || 'No se pudo recorrer la carpeta de Drive.',
        missingRoot: Boolean(error.missingRoot),
      });
    }

    job.completed += 1;
    await job.save();
    const result = job.results[job.results.length - 1];
    logEvent('agency_job_progress', {
      jobId: String(job._id),
      ownerEmail: job.ownerEmail,
      agency: agency.nombre,
      completed: job.completed,
      total: job.total,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  const hasIssues = job.results.some((result) => ['issues', 'failed'].includes(result.status));
  job.status = hasIssues ? 'completed_with_issues' : 'completed';
  job.currentName = '';
  job.expiresAt = hasIssues ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await job.save();
  const period = `${String(job.month).padStart(2, '0')}/${job.year}`;
  const processTitle = job.jobType === 'integrity' ? 'Verificación de archivos' : 'Actualización de archivos';
  const outcome = hasIssues ? 'terminó con incidencias' : 'se completó correctamente';
  try {
    await sendPushToUser(job.owner, {
      title: `${processTitle} ${hasIssues ? 'con incidencias' : 'completada'}`,
      body: `La ${processTitle.toLocaleLowerCase()} ${outcome} para ${period}: ${job.completed} de ${job.total} agencias procesadas.`,
      url: '/dashboard',
      tag: `agency-job-${job._id}`,
    });
  } catch (pushError) {
    logEvent('agency_job_push_failed', { jobId: String(job._id), message: pushError.message });
  }
  try {
    await Notification.create({
      title: `${processTitle} ${hasIssues ? 'con incidencias' : 'completada'}`,
      message: `La ${processTitle.toLocaleLowerCase()} ${outcome} para ${period}: ${job.completed} de ${job.total} agencias procesadas.`,
      severity: hasIssues ? 'medium' : 'low',
      audience: 'all',
      createdBy: job.owner,
    });
  } catch (notificationError) {
    logEvent('agency_notification_failed', { message: notificationError.message, jobId: String(job._id) });
  }
  await logServerEvent(job.jobType === 'integrity' ? 'agency_integrity_finished' : 'agency_refresh_finished', {
    userId: job.owner,
    jobId: job._id,
    status: job.status,
    completed: job.completed,
    total: job.total,
  });
}

async function failJob(job, error) {
  job.status = 'failed';
  job.error = error.message || 'No se pudo completar la actualización de archivos.';
  job.currentName = '';
  job.expiresAt = null;
  await job.save();
  try {
    await sendPushToUser(job.owner, {
      title: job.jobType === 'integrity' ? 'Falló la verificación de archivos' : 'Falló la actualización de archivos',
      body: job.error,
      url: '/dashboard',
      tag: `agency-job-${job._id}`,
    });
  } catch (pushError) {
    logEvent('agency_job_push_failed', { jobId: String(job._id), message: pushError.message });
  }
  await logServerEvent('agency_refresh_failed', {
    userId: job.owner,
    jobId: job._id,
    status: job.status,
    completed: job.completed,
    total: job.total,
    error: job.error.slice(0, 300),
  });
}

async function processQueuedJobs() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (true) {
      const job = await AgencyRefreshJob.findOneAndUpdate(
        { status: 'queued' },
        { $set: { status: 'processing' } },
        { sort: { createdAt: 1 }, new: true }
      ).select('+encryptedGoogleAccessToken');
      if (!job) break;
      await logServerEvent('agency_job_started', {
        userId: job.owner,
        jobId: job._id,
        status: job.status,
        total: job.total,
      });
      try {
        await processJob(job);
      } catch (error) {
        await failJob(job, error);
      }
    }
  })().finally(() => { workerPromise = null; });
  return workerPromise;
}

async function startAgencyRefreshJobWorker() {
  await AgencyRefreshJob.updateMany({ status: 'processing' }, { $set: { status: 'queued' } });
  kickAgencyRefreshJobWorker();
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      processQueuedJobs().catch((error) => logEvent('agency_refresh_worker_failed', { message: error.message }));
    }, 1500);
    pollTimer.unref?.();
  }
}

function kickAgencyRefreshJobWorker() {
  processQueuedJobs().catch((error) => logEvent('agency_refresh_worker_failed', { message: error.message }));
}

module.exports = { startAgencyRefreshJobWorker, kickAgencyRefreshJobWorker, isVerifiedForPeriod };
