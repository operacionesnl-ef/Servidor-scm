'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  agencyHasCurrentReports,
  buildNotificationFeed,
  getMexicoPeriod,
} = require('../src/utils/notificationUtils');

function agency(id, status, filePeriod) {
  return {
    _id: id,
    nombre: `Agencia ${id}`,
    status,
    archivos: Object.fromEntries(['archivo1', 'archivo2', 'archivo3', 'archivo4'].map((key) => [
      key,
      filePeriod
        ? { driveId: `${id}-${key}`, periodYear: filePeriod.year, periodMonth: filePeriod.month }
        : null,
    ])),
  };
}

test('monthly reminders only include active agencies missing current-period reports', () => {
  const now = new Date('2026-10-15T15:48:00.000Z');
  const feed = buildNotificationFeed({
    agencies: [
      agency('pending', 'activa', { year: 2026, month: 9 }),
      agency('current', 'activa', { year: 2026, month: 10 }),
      agency('inactive', 'inactiva', { year: 2026, month: 9 }),
      agency('suspended', 'suspendida', null),
    ],
    announcements: [],
    refreshJobs: [],
    mailJobs: [],
    userId: 'user-id',
    period: { year: 2026, month: 10 },
    now,
  });

  assert.equal(feed.counts.reminders, 1);
  assert.equal(feed.unreadCount, 1);
  assert.equal(feed.items[0].agencyId, 'pending');
  assert.equal(feed.items[0].period.label, '10/2026');
  assert.deepEqual(feed.items[0].missingFileCodes, ['ANX', 'FOR', 'REP', 'REV']);
  assert.match(feed.items[0].summary, /faltan ANX, FOR, REP, REV/);
  assert.equal(feed.items[0].createdAt, now.toISOString());
});

test('all four files must exist and match the selected reporting period', () => {
  const complete = agency('complete', 'activa', { year: 2026, month: 10 });
  const incomplete = agency('incomplete', 'activa', { year: 2026, month: 10 });
  incomplete.archivos.archivo4 = null;

  assert.equal(agencyHasCurrentReports(complete, 2026, 10), true);
  assert.equal(agencyHasCurrentReports(complete, 2026, 9), false);
  assert.equal(agencyHasCurrentReports(incomplete, 2026, 10), false);
});

test('notifications only require reports scheduled for the selected month', () => {
  const scheduled = agency('scheduled', 'activa', null);
  scheduled.reviewPeriods = {
    ambiental: { startPeriod: '2026-10', intervalMonths: 2 },
    seguridad: { startPeriod: '2026-10', intervalMonths: 3 },
  };

  assert.equal(agencyHasCurrentReports(scheduled, 2026, 11), true);
  assert.equal(agencyHasCurrentReports(scheduled, 2026, 12), false);

  const feed = buildNotificationFeed({
    agencies: [scheduled],
    announcements: [],
    refreshJobs: [],
    mailJobs: [],
    userId: 'user-id',
    period: { year: 2026, month: 11 },
  });
  assert.equal(feed.counts.reminders, 0);

  const environmentalDue = buildNotificationFeed({
    agencies: [scheduled],
    announcements: [],
    refreshJobs: [],
    mailJobs: [],
    userId: 'user-id',
    period: { year: 2026, month: 12 },
  });
  assert.equal(environmentalDue.items[0].summary, 'Agencia scheduled: faltan FOR del período 12/2026.');
});

test('global announcements track read state per user and administrative jobs are summarized', () => {
  const feed = buildNotificationFeed({
    agencies: [],
    announcements: [{
      _id: 'notice',
      title: 'Mantenimiento',
      message: 'Ventana programada',
      severity: 'medium',
      createdAt: new Date('2026-10-04T12:00:00Z'),
      readBy: ['user-id'],
    }],
    refreshJobs: [{
      _id: 'refresh-id',
      jobType: 'refresh',
      status: 'processing',
      total: 7,
      completed: 3,
      currentName: 'Agencia Norte',
      ownerEmail: 'admin@example.com',
      createdAt: new Date('2026-10-04T12:00:00Z'),
    }],
    mailJobs: [],
    userId: 'user-id',
    period: { year: 2026, month: 10 },
  });

  assert.equal(feed.unreadCount, 0);
  assert.equal(feed.counts.activeProcesses, 1);
  assert.equal(feed.items.find((item) => item.category === 'system').read, true);
  assert.match(feed.items.find((item) => item.category === 'process').summary, /3\/7/);
});

test('period calculation follows the Mexico City calendar month', () => {
  assert.deepEqual(getMexicoPeriod(new Date('2026-10-01T05:30:00.000Z')), { year: 2026, month: 9 });
});
