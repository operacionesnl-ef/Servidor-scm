'use strict';

const RESET = '\u001b[0m';
const COLORS = {
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  white: '\u001b[37m',
};

const EVENT_LABELS = {
  activity_log_retention_cleanup: 'Limpieza de actividad',
  activity_log_retention_cleanup_failed: 'Falló la limpieza de actividad',
  agency_email_unique_index_removed: 'Índice único de correo de agencias eliminado',
  agency_integrity_finished: 'Verificación de archivos terminada',
  agency_refresh_failed: 'Falló la actualización de agencias',
  agency_refresh_finished: 'Archivos de agencias actualizados',
  activity_log_failed: 'No se pudo guardar el registro de actividad',
  event_store_failed: 'No se pudo guardar el evento',
  job_finished: 'Envío terminado',
  job_queued: 'Envío en cola',
  job_recovered: 'Envío recuperado',
  job_started: 'Envío iniciado',
  'mail_job.recipient': 'Resultado de envío',
  server_started: 'Servidor iniciado',
  session_started: 'Sesión iniciada',
};

function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  return Boolean(stream.isTTY);
}

function paint(text, color, enabled = supportsColor()) {
  return enabled ? `${COLORS[color]}${text}${RESET}` : String(text);
}

function timestamp(date = new Date()) {
  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function terminalText(value) {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\r\n\t]/g, ' ');
}

function progressBar(completed, total, width = 18) {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(completed)) return '';
  const ratio = Math.max(0, Math.min(1, completed / total));
  const filled = Math.round(ratio * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

function formatRequest(entry, colorEnabled = supportsColor()) {
  const status = Number(entry.statusCode);
  const statusColor = status >= 500 ? 'red' : status >= 400 ? 'yellow' : 'green';
  const methodColor = entry.method === 'GET' ? 'cyan' : 'blue';
  const actor = entry.user?.correo ? ` · ${terminalText(entry.user.correo)}` : '';
  const duration = `${entry.durationMs} ms`;
  const durationColor = entry.durationMs > 1000 ? 'yellow' : 'dim';
  const extras = entry.data && Object.keys(entry.data).length
    ? `\n    ${paint('datos', 'dim', colorEnabled)} ${terminalText(JSON.stringify(entry.data))}`
    : '';

  return [
    `${paint(timestamp(new Date(entry.timestamp)), 'dim', colorEnabled)}  ${paint('HTTP', 'white', colorEnabled)}`,
    `${paint(String(entry.method).padEnd(6), methodColor, colorEnabled)}`,
    `${paint(String(status), statusColor, colorEnabled)}`,
    `${paint(duration, durationColor, colorEnabled)}`,
    `${terminalText(entry.path)}${actor}${extras}`,
  ].join(' ');
}

function formatEvent(event, details = {}, colorEnabled = supportsColor()) {
  const status = details.status || details.s;
  const failed = /failed|error|_failure/.test(event) || status === 'failed';
  const warning = status === 'completed_with_issues' || status === 'completed-with-errors';
  const level = failed ? 'ERROR' : warning ? 'WARN' : 'INFO';
  const levelColor = failed ? 'red' : warning ? 'yellow' : 'green';
  const label = terminalText(EVENT_LABELS[event] || event.replace(/[._]/g, ' '));
  const progress = progressBar(details.completed ?? details.c, details.total ?? details.n);
  const fields = [];

  if (status && !['failed', 'completed', 'completed_with_issues', 'completed-with-errors'].includes(status)) {
    fields.push(`estado: ${terminalText(status)}`);
  }
  if (progress) fields.push(progress);
  if (details.deleted !== undefined) fields.push(`eliminados: ${details.deleted}`);
  if (details.port !== undefined) fields.push(`puerto: ${details.port}`);
  if (details.pid !== undefined) fields.push(`PID: ${details.pid}`);
  if (details.jobId || details.j) fields.push(`trabajo: ${terminalText(details.jobId || details.j)}`);
  if (details.ownerEmail) fields.push(`usuario: ${terminalText(details.ownerEmail)}`);
  if (details.agency) fields.push(`agencia: ${terminalText(details.agency)}`);
  if (details.error || details.message) fields.push(`detalle: ${terminalText(details.error || details.message)}`);
  if (details.cutoff) fields.push(`desde: ${terminalText(details.cutoff)}`);

  const line = `${paint(timestamp(new Date(details.timestamp || details.at || Date.now())), 'dim', colorEnabled)}  ${paint(level, levelColor, colorEnabled)}  ${label}`;
  return fields.length ? `${line}\n    ${fields.join('  ·  ')}` : line;
}

function logEvent(event, details = {}) {
  const line = formatEvent(event, details);
  if (/failed|error|_failure/.test(event) || details.status === 'failed' || details.s === 'failed') {
    console.error(line);
  } else if (
    details.status === 'completed_with_issues' ||
    details.status === 'completed-with-errors' ||
    details.s === 'completed_with_issues' ||
    details.s === 'completed-with-errors'
  ) {
    console.warn(line);
  } else {
    console.info(line);
  }
}

function logRequest(entry) {
  console.info(formatRequest(entry));
}

function logError(context, error) {
  const message = error?.message || String(error);
  console.error(
    `${paint(timestamp(), 'dim')}  ${paint('ERROR', 'red')}  ${terminalText(context)}\n    ${terminalText(message)}`
  );
}

function logDatabaseConnected(host) {
  console.info([
    paint(' MongoDB ', 'white'),
    paint('conectado', 'green'),
    paint(host, 'dim'),
  ].join('  '));
}

function logStartup({ port, pid, database }) {
  const title = paint(' SISTEMA DE CORREOS MASIVOS ', 'cyan');
  const separator = paint('─'.repeat(48), 'dim');
  console.info(`\n${separator}\n${title}\n${separator}`);
  console.info(`  ${paint('Servidor', 'dim')} ${paint('listo', 'green')}  ·  puerto ${port}  ·  PID ${pid}`);
  console.info(`  ${paint('MongoDB', 'dim')}  ${database === 'connected' ? paint('conectado', 'green') : paint('desconectado', 'red')}`);
  console.info(`${separator}\n`);
}

module.exports = {
  formatEvent,
  formatRequest,
  logDatabaseConnected,
  logError,
  logEvent,
  logRequest,
  logStartup,
  paint,
  progressBar,
  supportsColor,
};
