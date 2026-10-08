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
  const directPeriods = [];

  segments.forEach((rawSegment, index) => {
    const segment = normalize(rawSegment);
    for (const match of segment.matchAll(/(?:19|20)\d{2}/g)) {
      years.push({ year: Number(match[0]), index });
    }

    const combinedDate = segment.match(/(?:^|\D)((?:19|20)\d{2})\D+(0?[1-9]|1[0-2])(?:\D|$)/);
    const reversedDate = segment.match(/(?:^|\D)(0?[1-9]|1[0-2])\D+((?:19|20)\d{2})(?:\D|$)/);
    if (combinedDate) directPeriods.push({ year: Number(combinedDate[1]), month: Number(combinedDate[2]), index });
    if (reversedDate) directPeriods.push({ year: Number(reversedDate[2]), month: Number(reversedDate[1]), index });

    MONTH_NAMES.forEach((name, monthIndex) => {
      if (new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(segment)) {
        months.push({ month: monthIndex + 1, index, explicit: true });
      }
    });

    if (/^(0?[1-9]|1[0-2])$/.test(segment)) {
      months.push({ month: Number(segment), index, explicit: false });
    }
  });

  if (directPeriods.length) {
    directPeriods.sort((left, right) => right.index - left.index);
    return directPeriods[0];
  }

  const pairs = [];
  years.forEach((year) => {
    months.forEach((month) => {
      const distance = Math.abs(year.index - month.index);
      if (distance <= 2) pairs.push({
        year: year.year,
        month: month.month,
        distance,
        monthIndex: month.index,
        explicit: month.explicit,
      });
    });
  });

  pairs.sort((left, right) => (
    Number(right.explicit) - Number(left.explicit) ||
    left.distance - right.distance ||
    right.monthIndex - left.monthIndex
  ));
  return pairs[0] ? { year: pairs[0].year, month: pairs[0].month } : null;
}

function periodFromFilenameForFolderMonth(name, folderMonth) {
  const dates = [...String(name || '').matchAll(/(?:^|[^\d])(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})(?=$|[^\d])/g)]
    .map((match) => {
      const first = Number(match[1]);
      const second = Number(match[2]);
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      const month = first > 12 ? second : second > 12 ? first : second;
      const day = first > 12 ? first : second > 12 ? second : first;
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
      return { year, month };
    })
    .filter(Boolean);

  const matchingDate = [...dates].reverse().find((date) => date.month === folderMonth);
  return matchingDate
    ? { year: matchingDate.year, month: matchingDate.month }
    : null;
}

function getFilePeriod(file) {
  const folderPath = Array.isArray(file.folderPath) ? file.folderPath.flatMap(splitPath) : [];
  const pathValue = String(file.path || '').trim();
  const pathWithoutFileName = file.name && pathValue.endsWith(file.name)
    ? pathValue.slice(0, -file.name.length).replace(/[\\/]+$/, '')
    : pathValue;
  const pathFolders = splitPath(pathWithoutFileName);
  const sources = folderPath.length ? [folderPath] : [pathFolders].filter((segments) => segments.length);
  let monthOnlyFolder = null;
  let hasFolderYear = false;

  for (const segments of sources) {
    if (segments.some((segment) => /(?:19|20)\d{2}/.test(segment))) hasFolderYear = true;
    const explicitMonth = segments.reduce((latest, segment) => {
      const normalized = normalize(segment);
      const monthIndex = MONTH_NAMES.findIndex((name) => (
        new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(normalized)
      ));
      return monthIndex >= 0 ? monthIndex + 1 : latest;
    }, null);
    if (explicitMonth) monthOnlyFolder = explicitMonth;
  }

  if (!hasFolderYear && monthOnlyFolder) {
    return periodFromFilenameForFolderMonth(file.name, monthOnlyFolder);
  }

  for (const segments of sources) {
    const period = periodFromSegments(segments);
    if (period) return period;
  }

  return monthOnlyFolder ? periodFromFilenameForFolderMonth(file.name, monthOnlyFolder) : null;
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
    if (!fileType || !period || periodNumber(period) !== requestedPeriod) continue;

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

module.exports = { FILE_TYPES, identifyFileType, getFilePeriod, selectRefreshFiles };