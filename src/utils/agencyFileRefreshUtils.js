'use strict';

const FILE_TYPES = [
  { key: 'archivo1', code: 'ANX', aliases: ['anexo', 'fotografico'] },
  { key: 'archivo2', code: 'FOR', aliases: ['formulario'] },
  { key: 'archivo3', code: 'REP', aliases: ['reporte', 'recorrido', 'inspeccion'] },
  { key: 'archivo4', code: 'REV', aliases: ['revision', 'extintores'] },
];

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const normalize = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const splitPath = (value) => String(value || '')
  .split(/[\\/]/)
  .map((part) => part.trim())
  .filter(Boolean);

const isDriveFolder = (file) => file.mimeType === 'application/vnd.google-apps.folder';

function periodFromSegments(segments) {
  const years = [];
  const months = [];

  segments.forEach((rawSegment, index) => {
    const segment = normalize(rawSegment);
    for (const match of segment.matchAll(/(?:19|20)\d{2}/g)) {
      years.push({ year: Number(match[0]), index });
    }

    MONTH_NAMES.forEach((name, monthIndex) => {
      if (new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(segment)) {
        months.push({ month: monthIndex + 1, index });
      }
    });

    const combinedDate = segment.match(/(?:19|20)\d{2}\D+(0?[1-9]|1[0-2])(?:\D|$)/);
    if (combinedDate) months.push({ month: Number(combinedDate[1]), index });
    const reversedDate = segment.match(/(?:^|\D)(0?[1-9]|1[0-2])\D+(?:19|20)\d{2}(?:\D|$)/);
    if (reversedDate) months.push({ month: Number(reversedDate[1]), index });

    if (/^(0?[1-9]|1[0-2])$/.test(segment)) {
      months.push({ month: Number(segment), index });
    }
  });

  const pairs = [];
  years.forEach((year) => {
    months.forEach((month) => {
      const distance = Math.abs(year.index - month.index);
      if (distance <= 2) pairs.push({ year: year.year, month: month.month, distance });
    });
  });

  pairs.sort((left, right) => left.distance - right.distance);
  return pairs[0] ? { year: pairs[0].year, month: pairs[0].month } : null;
}

function getFilePeriod(file) {
  const folderPath = Array.isArray(file.folderPath) ? file.folderPath.flatMap(splitPath) : [];
  const pathFolders = splitPath(file.path).slice(0, -1);
  const sources = [folderPath, pathFolders, [file.name]];

  for (const segments of sources) {
    const period = periodFromSegments(segments);
    if (period) return period;
  }

  return null;
}

function containsIdentifier(value, fileType) {
  const normalized = normalize(value);
  return [fileType.code, ...fileType.aliases].some((identifier) => (
    new RegExp(`(^|[^a-z0-9])${normalize(identifier)}(?=$|[^a-z0-9])`, 'i').test(normalized)
  ));
}

function matchingTypes(value, useAliases) {
  return FILE_TYPES.filter((fileType) => (
    useAliases
      ? fileType.aliases.some((alias) => containsIdentifier(value, { ...fileType, aliases: [alias] }))
      : containsIdentifier(value, { ...fileType, aliases: [] })
  ));
}

function identifyFileType(file) {
  if (isDriveFolder(file)) return null;

  const name = String(file.name || '');
  const explicitNameMatches = matchingTypes(name, false);
  if (explicitNameMatches.length === 1) return explicitNameMatches[0];
  if (explicitNameMatches.length > 1) return null;

  const nameMatches = matchingTypes(name, true);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) return null;

  const folderText = [
    ...(Array.isArray(file.folderPath) ? file.folderPath : []),
    ...splitPath(file.path).slice(0, -1),
  ].join(' / ');
  const explicitFolderMatches = matchingTypes(folderText, false);
  if (explicitFolderMatches.length === 1) return explicitFolderMatches[0];
  if (explicitFolderMatches.length > 1) return null;

  const folderMatches = matchingTypes(folderText, true);
  return folderMatches.length === 1 ? folderMatches[0] : null;
}

const periodNumber = ({ year, month }) => year * 12 + month;

function selectRefreshFiles(descendants, year, month) {
  const requestedPeriod = year * 12 + month;
  const selected = Object.fromEntries(FILE_TYPES.map(({ key }) => [key, null]));

  for (const file of descendants) {
    if (!file || typeof file !== 'object' || !file.id || !file.name) continue;
    if (isDriveFolder(file) || (!file.mimeType && !/\.[^./\\]+$/.test(file.name))) continue;

    const fileType = identifyFileType(file);
    const period = getFilePeriod(file);
    if (!fileType || !period || periodNumber(period) > requestedPeriod) continue;

    const current = selected[fileType.key];
    const currentPeriod = current ? periodNumber(current.period) : -1;
    const candidatePeriod = periodNumber(period);
    const candidateModified = Date.parse(file.modifiedTime || '') || 0;
    const currentModified = current ? Date.parse(current.file.modifiedTime || '') || 0 : 0;

    if (
      !current
      || candidatePeriod > currentPeriod
      || (candidatePeriod === currentPeriod && candidateModified > currentModified)
    ) {
      selected[fileType.key] = { file, period };
    }
  }

  return selected;
}

module.exports = { FILE_TYPES, selectRefreshFiles };