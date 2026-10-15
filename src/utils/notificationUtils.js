'use strict';

const { getFilePeriod } = require('./agencyFileRefreshUtils');

const FILE_KEYS = ['archivo1', 'archivo2', 'archivo3', 'archivo4'];

function getMexicoPeriod(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
  };
}

function agencyHasCurrentReports(agency, year, month) {
  return FILE_KEYS.every((key) => {
    const file = agency.archivos?.[key];
    if (!file?.driveId) return false;
    if (Number.isInteger(file.periodYear) && Number.isInteger(file.periodMonth)) {
      return file.periodYear === year && file.periodMonth === month;
    }

    const parsedPeriod = getFilePeriod({
      name: file.nombre,
      path: file.path,
      folderPath: file.pseudoPath,
    });
    return parsedPeriod?.year === year && parsedPeriod?.month === month;
  });
}

function createAgencyReminder(agency, year, month, createdAt = new Date()) {
  const period = `${String(month).padStart(2, '0')}/${year}`;
  return {
    id: `reminder:${year}-${String(month).padStart(2, '0')}:${String(agency._id)}`,
    category: 'reminder',
    title: 'Falta actualizar reportes',
    summary: `${agency.nombre}: faltan reportes del período ${period}.`,
    createdAt: createdAt.toISOString(),
    severity: 'medium',
    read: false,
    persistent: true,
    agencyId: String(agency._id),
    agencyName: agency.nombre,
    period: { year, month, label: period },
    actionUrl: '/agencias',
  };
}

function serializeAnnouncement(notification, userId) {
  return {
    id: String(notification._id),
    category: 'system',
    title: notification.title,
    summary: notification.message,
    createdAt: notification.createdAt,
    severity: notification.severity,
    read: notification.readBy.some((id) => String(id) === String(userId)),
    persistent: false,
  };
}

function serializeJob(job, category, title) {
  const progress = `${Number(job.completed) || 0}/${Number(job.total) || 0}`;
  const period = job.year && job.month
    ? ` · ${String(job.month).padStart(2, '0')}/${job.year}`
    : '';
  const owner = job.ownerEmail ? ` · ${job.ownerEmail}` : '';
  const status = ['queued', 'processing'].includes(job.status) ? 'En curso' : 'Finalizado';
  const outcome = job.status === 'failed'
    ? 'El proceso terminó con error.'
    : job.status === 'completed_with_issues'
      ? 'El proceso terminó con incidencias; consulta su historial.'
      : job.status === 'completed'
        ? 'El proceso terminó correctamente.'
        : '';

  return {
    id: `job:${category}:${String(job._id)}`,
    category: ['queued', 'processing'].includes(job.status) ? 'process' : 'change',
    title,
    summary: `${status}: ${progress}${period}${job.currentName ? ` · ${job.currentName}` : ''}${owner}${outcome ? ` · ${outcome}` : ''}`,
    createdAt: job.updatedAt || job.createdAt,
    severity: job.status === 'failed' || job.status === 'completed_with_issues' ? 'high' : 'low',
    read: true,
    persistent: false,
    status: job.status,
    completed: Number(job.completed) || 0,
    total: Number(job.total) || 0,
  };
}

function buildNotificationFeed({ agencies, announcements, refreshJobs, mailJobs, userId, period, now = new Date() }) {
  const reminders = agencies
    .filter((agency) => agency.status === 'activa' && !agencyHasCurrentReports(agency, period.year, period.month))
    .map((agency) => createAgencyReminder(agency, period.year, period.month, now));
  const announcementItems = announcements.map((notification) => serializeAnnouncement(notification, userId));
  const jobs = [
    ...refreshJobs.map((job) => serializeJob(
      job,
      job.jobType || 'refresh',
      job.jobType === 'integrity' ? 'Verificación de integridad' : 'Actualización de agencias',
    )),
    ...mailJobs.map((job) => serializeJob(job, 'mail', `Envío de correo · ${job.templateName}`)),
  ];
  const items = [...reminders, ...announcementItems, ...jobs]
    .sort((left, right) => {
      const priority = { reminder: 0, system: 1, process: 2, change: 3 };
      return priority[left.category] - priority[right.category]
        || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  const unreadAnnouncements = announcementItems.filter((item) => !item.read).length;

  return {
    items,
    unreadCount: reminders.length + unreadAnnouncements,
    counts: {
      reminders: reminders.length,
      unreadAnnouncements,
      activeProcesses: jobs.filter((item) => item.category === 'process').length,
    },
  };
}

module.exports = {
  FILE_KEYS,
  agencyHasCurrentReports,
  buildNotificationFeed,
  createAgencyReminder,
  getMexicoPeriod,
  serializeAnnouncement,
  serializeJob,
};
