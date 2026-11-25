'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  getResourceMetrics,
  shouldPauseMailJobs,
} = require('../src/services/resourceMonitor');

const RESOURCE_ENVIRONMENT_KEYS = [
  'MEMORY_LIMIT_BYTES',
  'MEMORY_PAUSE_THRESHOLD_PERCENT',
  'MEMORY_RESUME_THRESHOLD_PERCENT',
  'MAIL_MIN_AVAILABLE_MEMORY_BYTES',
];

function saveResourceEnvironment() {
  return Object.fromEntries(RESOURCE_ENVIRONMENT_KEYS.map((key) => [
    key,
    process.env[key],
  ]));
}

function restoreResourceEnvironment(environment) {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('resource monitor pauses complex work at the threshold and resumes below hysteresis', () => {
  const originalEnvironment = saveResourceEnvironment();

  try {
    process.env.MEMORY_PAUSE_THRESHOLD_PERCENT = '90';
    process.env.MEMORY_RESUME_THRESHOLD_PERCENT = '80';
    process.env.MEMORY_LIMIT_BYTES = '1';

    const highUsage = getResourceMetrics();
    assert.equal(highUsage.complexJobs.paused, true);
    assert.ok(highUsage.memory.usagePercentage >= 90);
    assert.ok(highUsage.memory.availableBytes === 0);

    process.env.MEMORY_LIMIT_BYTES = '9007199254740991';
    const recovered = getResourceMetrics();
    assert.equal(recovered.complexJobs.paused, false);
    assert.ok(recovered.memory.usagePercentage < 80);
    assert.ok(recovered.disk.totalBytes > 0);
    assert.ok(recovered.disk.availableBytes >= 0);
    assert.ok(recovered.cpu.cores > 0);
  } finally {
    process.env.MEMORY_PAUSE_THRESHOLD_PERCENT = '90';
    process.env.MEMORY_RESUME_THRESHOLD_PERCENT = '80';
    process.env.MEMORY_LIMIT_BYTES = '9007199254740991';
    getResourceMetrics();
    restoreResourceEnvironment(originalEnvironment);
  }
});

test('resource monitor rejects invalid threshold configuration', () => {
  const originalEnvironment = saveResourceEnvironment();
  process.env.MEMORY_PAUSE_THRESHOLD_PERCENT = '80';
  process.env.MEMORY_RESUME_THRESHOLD_PERCENT = '80';

  try {
    assert.throws(getResourceMetrics, /reanudación sea menor que pausa/);
  } finally {
    restoreResourceEnvironment(originalEnvironment);
  }
});

test('mail workers reserve memory before starting the next recipient', () => {
  const originalEnvironment = saveResourceEnvironment();

  try {
    process.env.MEMORY_LIMIT_BYTES = '9007199254740991';
    process.env.MAIL_MIN_AVAILABLE_MEMORY_BYTES = '9007199254740991';

    const reserved = getResourceMetrics();
    assert.equal(reserved.complexJobs.paused, false);
    assert.equal(reserved.complexJobs.mailJobsPaused, true);
    assert.equal(reserved.complexJobs.mailPauseReason, 'mail_memory_reserve');
    assert.equal(shouldPauseMailJobs(), true);

    process.env.MAIL_MIN_AVAILABLE_MEMORY_BYTES = '1';
    const available = getResourceMetrics();
    assert.equal(available.complexJobs.mailJobsPaused, false);
    assert.equal(shouldPauseMailJobs(), false);
  } finally {
    process.env.MEMORY_LIMIT_BYTES = '9007199254740991';
    process.env.MAIL_MIN_AVAILABLE_MEMORY_BYTES = '1';
    getResourceMetrics();
    restoreResourceEnvironment(originalEnvironment);
  }
});
