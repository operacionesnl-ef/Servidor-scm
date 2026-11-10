'use strict';

const os = require('node:os');
const { once } = require('node:events');
const mongoose = require('mongoose');
const JSZip = require('jszip');
const { getResourceMetrics } = require('../services/resourceMonitor');
const Agency = require('../models/Agency');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const AgencyRefreshJob = require('../models/AgencyRefreshJob');
const MailLog = require('../models/Maillog');
require('../models/AuthSession');

const FILE_FIELDS = ['archivo1', 'archivo2', 'archivo3', 'archivo4'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENSITIVE_EXPORT_PATHS = {
  User: ['autenticacion.passwordHash', 'tokenUnico'],
  AuthSession: ['tokenHash'],
  MailJob: ['encryptedGoogleAccessToken'],
  AgencyRefreshJob: ['encryptedGoogleAccessToken'],
};

function getPeriod(query, now = new Date()) {
  const year = query.year === undefined ? now.getUTCFullYear() : Number(query.year);
  const month = query.month === undefined ? now.getUTCMonth() + 1 : Number(query.month);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return { error: 'year debe ser un año entre 1900 y 2100.' };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: 'month debe ser un número entre 1 y 12.' };
  }
  return {
    year,
    month,
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

function isCompleteFile(file) {
  return Boolean(
    file &&
    typeof file.nombre === 'string' && file.nombre.trim() &&
    typeof file.ruta === 'string' && file.ruta.trim()
  );
}

async function getDashboard(req, res, next) {
  const period = getPeriod(req.query);
  if (period.error) {
    return res.status(400).json({ success: false, message: period.error });
  }

  try {
    const [agencies, monthlyRecords, mailLogs, latestIntegrityByAgency] = await Promise.all([
      Agency.find().select('nombre correo status archivos').lean(),
      AgencyMonthlyFiles.find({
        period: `${period.year}-${String(period.month).padStart(2, '0')}`,
      }).select('agencyId archivos').lean(),
      MailLog.find({
        $or: [
          { year: period.year, month: period.month },
          {
            year: { $exists: false },
            month: { $exists: false },
            createdAt: { $gte: period.start, $lt: period.end },
          },
        ],
      })
        .select('year month totalEnviados totalFallidos recipients.agencyId recipients.status')
        .lean(),
      AgencyRefreshJob.aggregate([
        {
          $match: {
            jobType: 'integrity',
            year: period.year,
            month: period.month,
            status: { $in: ['completed', 'completed_with_issues'] },
          },
        },
        { $sort: { createdAt: -1 } },
        { $unwind: '$results' },
        {
          $group: {
            _id: '$results.agencyId',
            checks: { $first: '$results.checks' },
            createdAt: { $first: '$createdAt' },
          },
        },
      ]),
    ]);

    const activeAgencies = agencies.filter((agency) => agency.status === 'activa');
    const monthlyFilesByAgency = new Map(monthlyRecords.map((record) => [
      String(record.agencyId),
      record.archivos || {},
    ]));
    const missingEmailAgencies = agencies.filter((agency) => (
      typeof agency.correo !== 'string' || !EMAIL_PATTERN.test(agency.correo.trim())
    ));
    const completeFileSlots = activeAgencies.reduce((total, agency) => (
      total + FILE_FIELDS.filter((field) => {
        return isCompleteFile(monthlyFilesByAgency.get(String(agency._id))?.[field]);
      }).length
    ), 0);
    const requiredFileSlots = activeAgencies.length * FILE_FIELDS.length;
    const emailedByAgency = new Map();
    let sentEmails = 0;
    let failedEmails = 0;

    for (const log of mailLogs) {
      sentEmails += log.totalEnviados || 0;
      failedEmails += log.totalFallidos || 0;
      for (const recipient of log.recipients || []) {
        if (recipient.status !== 'sent' || !recipient.agencyId) continue;
        const agencyId = String(recipient.agencyId);
        emailedByAgency.set(agencyId, (emailedByAgency.get(agencyId) || 0) + 1);
      }
    }

    const agencyById = new Map(agencies.map((agency) => [String(agency._id), agency]));
    const agenciesEmailed = [...emailedByAgency.entries()].map(([agencyId, sentCount]) => {
      const agency = agencyById.get(agencyId);
      return agency
        ? { id: agencyId, nombre: agency.nombre, correo: agency.correo, sentCount }
        : { id: agencyId, nombre: null, correo: null, sentCount };
    });

    const activeIds = new Set(activeAgencies.map((agency) => String(agency._id)));
    let verifiedFiles = 0;
    let checkedFiles = 0;
    let agenciesWithIntegrityCheck = 0;
    let latestCheckAt = null;
    for (const result of latestIntegrityByAgency) {
      if (!activeIds.has(String(result._id)) || !Array.isArray(result.checks)) continue;
      agenciesWithIntegrityCheck += 1;
      const checks = result.checks;
      checkedFiles += checks.length;
      verifiedFiles += checks.filter((check) => check.status === 'ok').length;
      if (!latestCheckAt || result.createdAt > latestCheckAt) latestCheckAt = result.createdAt;
    }

    return res.json({
      period: { year: period.year, month: period.month, start: period.start, end: period.end },
      agencies: {
        total: agencies.length,
        active: activeAgencies.length,
        missingEmail: missingEmailAgencies.length,
        missingEmailList: missingEmailAgencies.map(({ _id, nombre, correo }) => ({
          id: String(_id),
          nombre,
          correo: correo || null,
        })),
        emailedCount: agenciesEmailed.length,
        emailed: agenciesEmailed,
      },
      mail: {
        batches: mailLogs.length,
        sent: sentEmails,
        failed: failedEmails,
      },
      fileDataCompleteness: {
        completeSlots: completeFileSlots,
        requiredSlots: requiredFileSlots,
        percentage: requiredFileSlots ? (completeFileSlots / requiredFileSlots) * 100 : 0,
        basis: 'Archivos presentes y asociados al período seleccionado, entre cuatro espacios por agencia activa actual.',
      },
      integrityVerification: {
        checkedAgencies: agenciesWithIntegrityCheck,
        uncheckedActiveAgencies: activeAgencies.length - agenciesWithIntegrityCheck,
        verifiedFiles,
        checkedFiles,
        percentage: checkedFiles ? (verifiedFiles / checkedFiles) * 100 : 0,
        latestCheckAt,
        basis: 'Última verificación completada por agencia para el período seleccionado; solo estado ok cuenta como verificado.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getSystemMetrics(req, res, next) {
  const configuredStorageLimit = process.env.STORAGE_LIMIT_BYTES?.trim();
  const storageLimitBytes = !configuredStorageLimit
    ? null
    : Number(configuredStorageLimit);
  if (
    storageLimitBytes !== null &&
    (!Number.isSafeInteger(storageLimitBytes) || storageLimitBytes <= 0)
  ) {
    return res.status(500).json({
      success: false,
      message: 'STORAGE_LIMIT_BYTES debe ser un entero positivo.',
    });
  }

  try {
    const databaseStats = await mongoose.connection.db.stats();
    const memory = process.memoryUsage();
    const storageSizeBytes = databaseStats.storageSize;
    return res.json({
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
        },
      },
      host: {
        cpuCores: os.cpus().length,
        loadAverage: os.loadavg(),
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
      },
      resources: getResourceMetrics(),
      database: {
        name: mongoose.connection.name,
        state: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        collections: databaseStats.collections,
        documents: databaseStats.objects,
        dataSizeBytes: databaseStats.dataSize,
        storageSizeBytes,
        indexesSizeBytes: databaseStats.indexSize,
        storageLimitBytes,
        storageUsagePercentage: storageLimitBytes === null || storageSizeBytes == null
          ? null
          : (storageSizeBytes / storageLimitBytes) * 100,
      },
    });
  } catch (error) {
    return next(error);
  }
}

function getExportModels() {
  return mongoose.modelNames()
    .map((name) => mongoose.model(name))
    .filter((model) => !model.collection.name.startsWith('system.'));
}

async function getExportCollections(req, res, next) {
  try {
    const collections = await Promise.all(getExportModels().map(async (model) => ({
      name: model.collection.name,
      model: model.modelName,
      estimatedDocuments: await model.estimatedDocumentCount(),
      formats: ['json', 'csv'],
    })));
    return res.json({ collections });
  } catch (error) {
    return next(error);
  }
}

function getExportProjection(model) {
  return Object.fromEntries(
    (SENSITIVE_EXPORT_PATHS[model.modelName] || []).map((path) => [path, 0])
  );
}

function sanitizeExportDocument(model, document) {
  const output = { ...document };
  for (const path of SENSITIVE_EXPORT_PATHS[model.modelName] || []) {
    const segments = path.split('.');
    let parent = output;
    for (const segment of segments.slice(0, -1)) {
      parent = parent?.[segment];
      if (!parent) break;
    }
    if (parent) delete parent[segments[segments.length - 1]];
  }
  return output;
}

function csvFieldsForModel(model) {
  const excluded = new Set(SENSITIVE_EXPORT_PATHS[model.modelName] || []);
  return Object.keys(model.schema.paths)
    .filter((path) => path !== '__v' && !excluded.has(path));
}

function getDocumentValue(document, path) {
  const [segment, ...remaining] = path.split('.');
  const value = document?.[segment];
  if (Array.isArray(value)) {
    return value.map((item) => remaining.length ? getDocumentValue(item, remaining.join('.')) : item);
  }
  if (remaining.length) return getDocumentValue(value, remaining.join('.'));
  return value;
}

function csvCell(value) {
  if (value == null) return '';
  let text = value instanceof Date
    ? value.toISOString()
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeWithBackpressure(res, text) {
  if (res.write(text)) return true;
  await Promise.race([once(res, 'drain'), once(res, 'close')]);
  return !res.destroyed;
}

async function exportCollection(req, res, next) {
  const { collection } = req.params;
  const format = req.query.format || 'json';
  if (!['json', 'csv'].includes(format)) {
    return res.status(400).json({ success: false, message: 'format debe ser json o csv.' });
  }

  const model = getExportModels().find((candidate) => candidate.collection.name === collection);
  if (!model) {
    return res.status(404).json({ success: false, message: 'Colección exportable no encontrada.' });
  }

  const filename = `${collection}-${new Date().toISOString().slice(0, 10)}.${format}`;
  res.attachment(filename);
  res.type(format === 'json' ? 'json' : 'text/csv');

  const cursor = model.collection.find({}, { projection: getExportProjection(model) });
  try {
    if (format === 'json') {
      if (!await writeWithBackpressure(res, '[')) return;
      let first = true;
      for await (const document of cursor) {
        const item = JSON.stringify(sanitizeExportDocument(model, document));
        if (!await writeWithBackpressure(res, `${first ? '' : ','}${item}`)) return;
        first = false;
      }
      res.end(']');
      return;
    }

    const fields = csvFieldsForModel(model);
    if (!await writeWithBackpressure(res, `${fields.map(csvCell).join(',')}\r\n`)) return;
    for await (const document of cursor) {
      const row = fields.map((field) => csvCell(getDocumentValue(document, field))).join(',');
      if (!await writeWithBackpressure(res, `${row}\r\n`)) return;
    }
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    return next(error);
  } finally {
    await cursor.close();
  }
}

async function exportFullDatabase(req, res, next) {
  try {
    const database = mongoose.connection.db;
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const zip = new JSZip();
    const exportedAt = new Date().toISOString().slice(0, 10);

    for (const { name } of collections) {
      if (name.startsWith('system.')) continue;
      const model = getExportModels().find((candidate) => candidate.collection.name === name);
      const projection = model ? getExportProjection(model) : {};
      const documents = await database.collection(name).find({}, { projection }).toArray();
      const sanitizedDocuments = model
        ? documents.map((document) => sanitizeExportDocument(model, document))
        : documents;
      zip.file(`${name}.json`, JSON.stringify(sanitizedDocuments));
    }

    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.attachment(`database-${exportedAt}.zip`);
    res.type('application/zip');
    return res.send(archive);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getDashboard,
  getSystemMetrics,
  getExportCollections,
  exportCollection,
  exportFullDatabase,
};
