'use strict';

const GenerationJob = require('../models/GenerationJob');
const { logConsoleEvent } = require('../../utils/serverLogger');
const { shouldPauseComplexJobs } = require('../../services/resourceMonitor');

const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 1000;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const processors = new Map();
let workerPromise = null;
let pollTimer = null;

function jobKey(type, entityId, revision, templateVersion) {
  return `${String(type).toUpperCase()}:${entityId}:${revision}:${templateVersion || '1'}`;
}

async function enqueueGeneration({ type, entityId, reportId, revision, userId, templateVersion }) {
  const key = jobKey(type, entityId, revision, templateVersion);
  const existing = await GenerationJob.findOne({ key });
  if (existing && ['queued', 'processing'].includes(existing.status)) return existing;

  const update = {
    $set: {
      type: String(type).toUpperCase(),
      entityId,
      reportId,
      revision,
      templateVersion: templateVersion || '1',
      userId: userId || null,
      status: 'queued',
      step: 'queued',
      attempts: 0,
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      error: '',
    },
    $push: { events: { step: 'queued', status: 'queued', message: 'Trabajo agregado a la cola.' } },
    $setOnInsert: { key },
  };
  return GenerationJob.findOneAndUpdate({ key }, update, { upsert: true, new: true, runValidators: true });
}

async function recordGenerationStep(job, step, status = 'processing', message = '') {
  const now = new Date();
  await GenerationJob.updateOne(
    { _id: job._id, status: 'processing' },
    {
      $set: { step, updatedAt: now },
      $push: { events: { step, status, message: String(message).slice(0, 1000), at: now } },
    },
  );
  logConsoleEvent('generation_job_step', {
    jobId: String(job._id),
    reportId: job.reportId,
    type: job.type,
    step,
    status,
    message,
  });
}

function registerGenerationProcessor(type, processor) {
  processors.set(String(type).toUpperCase(), processor);
}

async function claimNextJob() {
  return GenerationJob.findOneAndUpdate(
    { status: 'queued', attempts: { $lt: MAX_ATTEMPTS } },
    {
      $set: { status: 'processing', step: 'starting', startedAt: new Date(), error: '' },
      $inc: { attempts: 1 },
      $push: { events: { step: 'starting', status: 'processing', message: 'Intento iniciado.' } },
    },
    { sort: { queuedAt: 1 }, new: true },
  );
}

async function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  await GenerationJob.updateMany(
    { status: 'processing', startedAt: { $lt: staleBefore }, attempts: { $lt: MAX_ATTEMPTS } },
    {
      $set: { status: 'queued', step: 'recovered', startedAt: null, queuedAt: new Date() },
      $push: { events: { step: 'recovered', status: 'queued', message: 'Trabajo recuperado después de una interrupción.' } },
    },
  );
  await GenerationJob.updateMany(
    { status: 'processing', startedAt: { $lt: staleBefore }, attempts: { $gte: MAX_ATTEMPTS } },
    {
      $set: { status: 'failed', step: 'failed', finishedAt: new Date(), error: 'Se agotaron los intentos después de una interrupción del servidor.' },
      $push: { events: { step: 'failed', status: 'failed', message: 'Se agotaron los intentos después de una interrupción del servidor.' } },
    },
  );
}

async function processQueue() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    while (true) {
      if (shouldPauseComplexJobs()) break;
      const job = await claimNextJob();
      if (!job) break;
      const processor = processors.get(job.type);
      if (!processor) {
        await GenerationJob.updateOne(
          { _id: job._id, status: 'processing' },
          { $set: { status: 'failed', step: 'failed', error: `No hay procesador registrado para ${job.type}.`, finishedAt: new Date() } },
        );
        continue;
      }
      try {
        await processor(job, (step, status, message) => recordGenerationStep(job, step, status, message));
        await GenerationJob.updateOne(
          { _id: job._id, status: 'processing' },
          {
            $set: { status: 'ready', step: 'completed', finishedAt: new Date(), error: '' },
            $push: { events: { step: 'completed', status: 'completed', message: 'Archivo generado y confirmado.' } },
          },
        );
      } catch (error) {
        const message = String(error?.message || 'Error al generar el archivo.').slice(0, 1000);
        const retry = job.attempts < MAX_ATTEMPTS;
        await GenerationJob.updateOne(
          { _id: job._id, status: 'processing' },
          {
            $set: {
              status: retry ? 'queued' : 'failed',
              step: retry ? 'retrying' : 'failed',
              error: message,
              startedAt: null,
              ...(retry ? { queuedAt: new Date() } : { finishedAt: new Date() }),
            },
            $push: { events: { step: retry ? 'retrying' : 'failed', status: retry ? 'retrying' : 'failed', message } },
          },
        );
        logConsoleEvent('generation_job_failed', { jobId: String(job._id), reportId: job.reportId, type: job.type, attempts: job.attempts, message });
      }
    }
  })().finally(() => { workerPromise = null; });
  return workerPromise;
}

function kickGenerationQueue() {
  processQueue().catch((error) => logConsoleEvent('generation_queue_failed', { message: error.message }));
}

async function startGenerationQueue() {
  await recoverStaleJobs();
  if (!pollTimer) {
    pollTimer = setInterval(async () => {
      try {
        await recoverStaleJobs();
        await processQueue();
      } catch (error) {
        logConsoleEvent('generation_queue_failed', { message: error.message });
      }
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }
  kickGenerationQueue();
}

module.exports = {
  enqueueGeneration,
  kickGenerationQueue,
  recordGenerationStep,
  registerGenerationProcessor,
  startGenerationQueue,
};
