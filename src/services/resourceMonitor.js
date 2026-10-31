'use strict';

const fs = require('node:fs');
const os = require('node:os');

const DEFAULT_PAUSE_THRESHOLD_PERCENT = 90;
const DEFAULT_RESUME_THRESHOLD_PERCENT = 80;
const SAMPLE_INTERVAL_MS = 5000;
const CGROUP_MEMORY_PATHS = [
  ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
  ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
];

let complexWorkPaused = false;
let monitorTimer = null;

function readPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} debe ser un entero positivo.`);
  }
  return parsed;
}

function getThresholds() {
  const pauseThresholdPercent = process.env.MEMORY_PAUSE_THRESHOLD_PERCENT === undefined
    ? DEFAULT_PAUSE_THRESHOLD_PERCENT
    : Number(process.env.MEMORY_PAUSE_THRESHOLD_PERCENT);
  const resumeThresholdPercent = process.env.MEMORY_RESUME_THRESHOLD_PERCENT === undefined
    ? DEFAULT_RESUME_THRESHOLD_PERCENT
    : Number(process.env.MEMORY_RESUME_THRESHOLD_PERCENT);

  if (
    !Number.isFinite(pauseThresholdPercent) ||
    !Number.isFinite(resumeThresholdPercent) ||
    pauseThresholdPercent < 0 ||
    resumeThresholdPercent < 0 ||
    pauseThresholdPercent > 100 ||
    resumeThresholdPercent > 100 ||
    resumeThresholdPercent >= pauseThresholdPercent
  ) {
    throw new Error(
      'Configura MEMORY_RESUME_THRESHOLD_PERCENT y MEMORY_PAUSE_THRESHOLD_PERCENT con valores entre 0 y 100, donde reanudación sea menor que pausa.'
    );
  }

  return { pauseThresholdPercent, resumeThresholdPercent };
}

function readCgroupMemory() {
  for (const [limitPath, usagePath] of CGROUP_MEMORY_PATHS) {
    try {
      const rawLimit = fs.readFileSync(limitPath, 'utf8').trim();
      const rawUsage = fs.readFileSync(usagePath, 'utf8').trim();
      if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawUsage)) continue;
      const limitBytes = Number(rawLimit);
      const usedBytes = Number(rawUsage);
      if (
        !Number.isSafeInteger(limitBytes) ||
        !Number.isSafeInteger(usedBytes) ||
        limitBytes <= 0 ||
        limitBytes >= 2 ** 60
      ) continue;
      return { limitBytes, usedBytes, source: 'cgroup' };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }

  return null;
}

function updatePauseState(usagePercentage, { pauseThresholdPercent, resumeThresholdPercent }) {
  const wasPaused = complexWorkPaused;
  if (usagePercentage !== null) {
    if (!complexWorkPaused && usagePercentage >= pauseThresholdPercent) {
      complexWorkPaused = true;
    } else if (complexWorkPaused && usagePercentage <= resumeThresholdPercent) {
      complexWorkPaused = false;
    }
  }

  if (wasPaused !== complexWorkPaused) {
    const message = complexWorkPaused
      ? `Memoria al ${usagePercentage.toFixed(1)}%; se pausan nuevos trabajos complejos.`
      : `Memoria al ${usagePercentage.toFixed(1)}%; se reanudan los trabajos complejos.`;
    console.warn(`[ResourceMonitor] ${message}`);
  }
}

function getResourceMetrics() {
  const thresholds = getThresholds();
  const processMemory = process.memoryUsage();
  const configuredMemoryLimit = process.env.MEMORY_LIMIT_BYTES?.trim();
  const cgroupMemory = readCgroupMemory();
  const memoryLimitBytes = configuredMemoryLimit
    ? readPositiveInteger(configuredMemoryLimit, 'MEMORY_LIMIT_BYTES')
    : cgroupMemory?.limitBytes ?? null;
  const memoryUsedBytes = cgroupMemory?.usedBytes ?? processMemory.rss;
  const memoryUsagePercentage = memoryLimitBytes === null
    ? null
    : (memoryUsedBytes / memoryLimitBytes) * 100;

  updatePauseState(memoryUsagePercentage, thresholds);

  const disk = fs.statfsSync(process.cwd());
  const diskBlockSize = disk.bsize;
  const diskTotalBytes = disk.blocks * diskBlockSize;
  const diskAvailableBytes = disk.bavail * diskBlockSize;

  return {
    memory: {
      limitBytes: memoryLimitBytes,
      usedBytes: memoryUsedBytes,
      availableBytes: memoryLimitBytes === null
        ? null
        : Math.max(0, memoryLimitBytes - memoryUsedBytes),
      usagePercentage: memoryUsagePercentage,
      limitSource: configuredMemoryLimit ? 'configured' : cgroupMemory ? 'cgroup' : null,
      usageSource: cgroupMemory ? 'cgroup' : 'process',
      processRssBytes: processMemory.rss,
      processHeapUsedBytes: processMemory.heapUsed,
      pauseThresholdPercent: thresholds.pauseThresholdPercent,
      resumeThresholdPercent: thresholds.resumeThresholdPercent,
    },
    disk: {
      totalBytes: diskTotalBytes,
      availableBytes: diskAvailableBytes,
      usedBytes: diskTotalBytes - diskAvailableBytes,
      usagePercentage: diskTotalBytes
        ? ((diskTotalBytes - diskAvailableBytes) / diskTotalBytes) * 100
        : null,
    },
    cpu: {
      cores: os.cpus().length,
      loadAverage: os.loadavg(),
    },
    complexJobs: {
      paused: complexWorkPaused,
      reason: complexWorkPaused ? 'memory_threshold' : null,
    },
  };
}

function shouldPauseComplexJobs() {
  return getResourceMetrics().complexJobs.paused;
}

function startResourceMonitor() {
  if (monitorTimer) return;
  getResourceMetrics();
  monitorTimer = setInterval(() => {
    try {
      getResourceMetrics();
    } catch (error) {
      console.error('[ResourceMonitor] No se pudieron actualizar las métricas:', error);
    }
  }, SAMPLE_INTERVAL_MS);
  monitorTimer.unref?.();
}

module.exports = {
  getResourceMetrics,
  shouldPauseComplexJobs,
  startResourceMonitor,
};
