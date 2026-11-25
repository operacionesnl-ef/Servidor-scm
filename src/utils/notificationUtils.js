'use strict';

const { getFilePeriod } = require('./agencyFileRefreshUtils');
const { isReviewDue } = require('./reviewPeriod');

const FILE_REPORTS = [
  { key: 'archivo1', code: 'ANX', category: 'seguridad' },
  { key: 'archivo2', code: 'FOR', category: 'ambiental' },
  { key: 'archivo3', code: 'REP', category: 'seguridad' },
  { key: 'archivo4', code: 'REV', category: 'seguridad' },
];
const FILE_KEYS = FILE_REPORTS.map(({ key }) => key);

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

function getMissingCurrentReportCodes(agency, year, month) {
  return FILE_REPORTS.filter(({ key, category }) => {
    if (!isReviewDue(agency.reviewPeriods, category, year, month)) return false;
    const file = agency.archivos?.[key];
    if (!file?.driveId) return true;
    if (Number.isInteger(file.periodYear) && Number.isInteger(file.periodMonth)) {
      return file.periodYear !== year || file.periodMonth !== month;
    }

    const parsedPeriod = getFilePeriod({
      name: file.nombre,
      path: file.path,
      folderPath: file.pseudoPath,
    });
    return parsedPeriod?.year !== year || parsedPeriod?.month !== month;
  }).map(({ code }) => code);
}

function agencyHasCurrentReports(agency, year, month) {
  return getMissingCurrentReportCodes(agency, year, month).length === 0;
}

function createAgencyReminderGroup(agencies, year, month, userId, scope, now = new Date()) {
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  const period = `${String(month).padStart(2, '0')}/${year}`;
  const relatedItems = agencies
    .map((agency) => ({
      id: String(agency._id),
      name: agency.nombre || 'Agencia sin nombre',
      missingFileCodes: getMissingCurrentReportCodes(agency, year, month),
      consultantNames: agency.consultantNames || [],
      actionUrl: `/agencias/${encodeURIComponent(String(agency._id))}?tab=files`,
    }))
    .filter((agency) => agency.missingFileCodes.length)
    .sort((left, right) => left.name.localeCompare(right.name, 'es-MX'));
  if (!relatedItems.length) return null;

  const groupScope = scope === 'consultant' ? `consultant:${String(userId)}` : 'global';
  const id = `pending_files:${groupScope}:${periodKey}`;
  const count = relatedItems.length;
  const createdAt = new Date(Date.UTC(year, month - 1, 1, 6)).toISOString();

  return {
    id,
    groupKey: id,
    type: 'pending_files',
    notificationType: 'pending_files',
    category: 'reminder',
    priority: 2,
    status: 'active',
    scope,
    ...(scope === 'consultant' ? { recipientId: String(userId) } : {}),
    title: 'Faltan archivos por actualizar',
    summary: `${count} agencia${count === 1 ? '' : 's'} ${count === 1 ? 'tiene' : 'tienen'} archivos pendientes del período ${period}.`,
    createdAt,
    updatedAt: now.toISOString(),
    severity: 'medium',
    read: false,
    persistent: true,
    itemCount: count,
    relatedItems,
    period: { year, month, label: period },
  };
}

function createPendingInspectionGroup(type, relatedItems, year, month, userId, scope, now) {
  if (!relatedItems.length) return null;
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  const periodLabel = `${String(month).padStart(2, '0')}/${year}`;
  const groupScope = type === 'pending_authorization'
    ? 'admin'
    : scope === 'consultant' ? `consultant:${String(userId)}` : 'global';
  const id = `${type}:${groupScope}:${periodKey}`;
  const count = relatedItems.length;
  const isAuthorization = type === 'pending_authorization';
  const isSingle = count === 1;

  return {
    id,
    groupKey: id,
    type,
    notificationType: type,
    category: 'reminder',
    priority: isAuthorization ? 1 : 2,
    status: 'active',
    scope: isAuthorization ? 'admin' : scope,
    ...(!isAuthorization && scope === 'consultant' ? { recipientId: String(userId) } : {}),
    title: isAuthorization ? 'Visitas pendientes de autorización' : 'Agencias sin visita programada',
    summary: isAuthorization
      ? `Hay ${count} visita${isSingle ? '' : 's'} esperando autorización del período ${periodLabel}.`
      : `${count} agencia${isSingle ? '' : 's'} ${isSingle ? 'necesita' : 'necesitan'} programar una visita durante el período ${periodLabel}.`,
    createdAt: new Date(Date.UTC(year, month - 1, 1, 6)).toISOString(),
    updatedAt: now.toISOString(),
    severity: isAuthorization ? 'high' : 'medium',
    read: false,
    persistent: true,
    itemCount: count,
    relatedItems,
    period: { year, month, label: periodLabel },
  };
}

function createPendingInspectionGroups({
  agencies,
  inspections,
  calendarEvents,
  userId,
  scope,
  period,
  now,
}) {
  const agenciesById = new Map(agencies.map((agency) => [String(agency._id), agency]));
  const eventsById = new Map(calendarEvents.map((event) => [String(event._id), event]));
  const scheduleItems = [];
  const authorizationItems = [];

  for (const inspection of inspections) {
    const agency = agenciesById.get(String(inspection.agencyId));
    if (!agency || agency.status !== 'activa' || inspection.visitStatus === 'completed') continue;

    const event = inspection.calendarEventId
      ? eventsById.get(String(inspection.calendarEventId))
      : null;
    const authorizationStatus = inspection.authorizationStatus || 'pending';
    const agencyId = String(agency._id);
    const agencyName = agency.nombre || 'Agencia sin nombre';

    if (event && event.authorized === false && authorizationStatus === 'pending') {
      authorizationItems.push({
        id: `${agencyId}:${String(event._id)}`,
        agencyId,
        name: agencyName,
        startAt: event.startAt,
        consultantNames: agency.consultantNames || [],
        authorizationStatus,
        actionUrl: `/calendario?agencyId=${encodeURIComponent(agencyId)}`,
      });
      continue;
    }

    if (!event && authorizationStatus === 'authorized') {
      scheduleItems.push({
        id: agencyId,
        agencyId,
        name: agencyName,
        scheduleStatus: inspection.scheduleStatus || 'pending',
        scheduleReason: inspection.scheduleReason || '',
        consultantNames: agency.consultantNames || [],
        actionUrl: `/agencias/${encodeURIComponent(agencyId)}?tab=inspections`,
      });
    }
  }

  const scheduleGroup = createPendingInspectionGroup(
    'pending_schedule',
    scheduleItems.sort((left, right) => left.name.localeCompare(right.name, 'es-MX')),
    period.year,
    period.month,
    userId,
    scope,
    now,
  );
  const authorizationGroup = scope === 'global'
    ? createPendingInspectionGroup(
      'pending_authorization',
      authorizationItems.sort((left, right) => (
        new Date(left.startAt).getTime() - new Date(right.startAt).getTime()
      )),
      period.year,
      period.month,
      userId,
      scope,
      now,
    )
    : null;

  return [scheduleGroup, authorizationGroup].filter(Boolean);
}

function serializeAnnouncement(notification, userId) {
  const personal = notification.audience === 'personal';
  const severityPriority = { high: 0, medium: 3, low: 4 };
  const typePriority = {
    visit_reminder: 0,
    calendar_reminder: 1,
    visit_scheduled: 1,
    visit_changed: 1,
    visit_authorized: 2,
    visit_not_authorized: 2,
    visit_attendance_confirmed: 3,
    visit_attendance_confirmation: 3,
    agency_assigned: 3,
    agency_unassigned: 3,
    pending_files: 2,
    pending_schedule: 2,
    pending_authorization: 1,
  };
  const notificationType = notification.notificationType || 'announcement';
  const priority = typePriority[notificationType] === undefined
    ? severityPriority[notification.severity] ?? 4
    : Math.min(typePriority[notificationType], severityPriority[notification.severity] ?? 4);
  return {
    id: String(notification._id),
    category: personal ? 'personal' : 'system',
    type: notificationType,
    notificationType,
    priority,
    status: 'active',
    scope: notification.audience,
    title: notification.title,
    summary: notification.message,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt || notification.createdAt,
    severity: notification.severity,
    read: notification.readBy.some((id) => String(id) === String(userId)),
    persistent: false,
    ...(notification.actionUrl ? { actionUrl: notification.actionUrl } : {}),
    ...(notification.agencyId ? { agencyId: String(notification.agencyId) } : {}),
    ...(notification.notificationType ? { notificationType: notification.notificationType } : {}),
  };
}

function serializeJob(job, category, title) {
  const progress = `${Number(job.completed) || 0}/${Number(job.total) || 0}`;
  const period = job.year && job.month
    ? ` · ${String(job.month).padStart(2, '0')}/${job.year}`
    : '';
  const owner = job.ownerEmail ? ` · ${job.ownerEmail}` : '';
  const isActive = ['queued', 'processing'].includes(job.status);
  const isFailed = job.status === 'failed' || job.status === 'completed_with_issues';
  const status = isActive ? 'En curso' : 'Finalizado';
  const outcome = job.status === 'failed'
    ? 'El proceso terminó con error.'
    : job.status === 'completed_with_issues'
      ? 'El proceso terminó con incidencias; consulta su historial.'
      : job.status === 'completed'
        ? 'El proceso terminó correctamente.'
        : '';

  return {
    id: `job:${category}:${String(job._id)}`,
    type: `process_${category}`,
    notificationType: `process_${category}`,
    category: isActive ? 'process' : 'change',
    priority: isFailed ? 0 : isActive ? 1 : 4,
    status: isActive ? 'active' : job.status,
    scope: 'admin',
    title,
    summary: `${status}: ${progress}${period}${job.currentName ? ` · ${job.currentName}` : ''}${owner}${outcome ? ` · ${outcome}` : ''}`,
    createdAt: job.updatedAt || job.createdAt,
    updatedAt: job.updatedAt || job.createdAt,
    severity: isFailed ? 'high' : 'low',
    read: true,
    persistent: false,
    processId: String(job._id),
    processType: category,
    progress: {
      completed: Number(job.completed) || 0,
      total: Number(job.total) || 0,
      currentName: job.currentName || '',
    },
    completed: Number(job.completed) || 0,
    total: Number(job.total) || 0,
  };
}

function buildNotificationFeed({
  agencies,
  announcements,
  refreshJobs,
  mailJobs,
  userId,
  period,
  scope = 'global',
  inspections = [],
  calendarEvents = [],
  now = new Date(),
}) {
  const activeAgencies = agencies.filter((agency) => agency.status === 'activa');
  const reminderGroup = createAgencyReminderGroup(
    activeAgencies,
    period.year,
    period.month,
    userId,
    scope,
    now,
  );
  const reminders = reminderGroup ? [reminderGroup] : [];
  const inspectionGroups = createPendingInspectionGroups({
    agencies: activeAgencies,
    inspections,
    calendarEvents,
    userId,
    scope,
    period,
    now,
  });
  const pendingGroups = [...reminders, ...inspectionGroups];
  const announcementItems = announcements.map((notification) => serializeAnnouncement(notification, userId));
  const jobs = [
    ...refreshJobs.map((job) => serializeJob(
      job,
      job.jobType || 'refresh',
      job.jobType === 'integrity' ? 'Verificación de integridad' : 'Actualización de agencias',
    )),
    ...mailJobs.map((job) => serializeJob(job, 'mail', `Envío de correo · ${job.templateName}`)),
  ];
  const items = [...pendingGroups, ...announcementItems, ...jobs]
    .sort((left, right) => {
      const leftPriority = Number.isFinite(left.priority) ? left.priority : 4;
      const rightPriority = Number.isFinite(right.priority) ? right.priority : 4;
      return leftPriority - rightPriority
        || new Date(right.updatedAt || right.createdAt).getTime()
          - new Date(left.updatedAt || left.createdAt).getTime();
    });
  const unreadAnnouncements = announcementItems.filter((item) => item.category === 'system' && !item.read).length;
  const unreadPersonal = announcementItems.filter((item) => item.category === 'personal' && !item.read).length;
  const pendingAgencyIds = new Set(pendingGroups.flatMap((group) => (
    group.relatedItems.map((item) => item.agencyId || item.id)
  )));
  const pendingAgencyCount = pendingAgencyIds.size;

  return {
    items,
    unreadCount: pendingGroups.length + unreadAnnouncements + unreadPersonal,
    counts: {
      reminders: reminderGroup?.itemCount || 0,
      pendingGroups: pendingGroups.length,
      pendingAgencies: pendingAgencyCount,
      unreadAnnouncements,
      unreadPersonal,
      activeProcesses: jobs.filter((item) => item.category === 'process').length,
    },
  };
}

module.exports = {
  FILE_KEYS,
  agencyHasCurrentReports,
  buildNotificationFeed,
  createAgencyReminderGroup,
  createPendingInspectionGroups,
  getMissingCurrentReportCodes,
  getMexicoPeriod,
  serializeAnnouncement,
  serializeJob,
};
