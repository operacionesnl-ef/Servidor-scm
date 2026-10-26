'use strict';

require('../config/env');
const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');
const { getFilePeriod } = require('../utils/agencyFileRefreshUtils');

const FILE_KEYS = ['archivo1', 'archivo2', 'archivo3', 'archivo4'];
const MIN_YEAR = 2020;
const MAX_YEAR = 2040;

function inferFilePeriod(file) {
  const explicit = Number.isInteger(file.periodYear) && Number.isInteger(file.periodMonth)
    ? { year: file.periodYear, month: file.periodMonth }
    : getFilePeriod({
      name: file.nombre,
      folderPath: file.pseudoPath || [],
      path: file.path || '',
    });
  return explicit && explicit.year >= MIN_YEAR && explicit.year <= MAX_YEAR &&
    explicit.month >= 1 && explicit.month <= 12 ? explicit : null;
}

async function migrate({ apply = false } = {}) {
  if (apply) await AgencyMonthlyFiles.createIndexes();
  const stats = {
    agenciesScanned: 0,
    legacyFilesFound: 0,
    filesMigratable: 0,
    filesMigrated: 0,
    unresolvedFiles: [],
    conflictingFiles: [],
    periodsFound: 0,
    recordsCreated: 0,
    monthlyFolderFieldsRemoved: 0,
    applied: apply,
  };
  const cursor = Agency.find({ archivos: { $exists: true } })
    .select('_id archivos updatedAt')
    .lean()
    .cursor({ batchSize: 250 });

  for await (const agency of cursor) {
    stats.agenciesScanned += 1;
    const groups = new Map();
    for (const key of FILE_KEYS) {
      const file = agency.archivos?.[key];
      if (!file || typeof file !== 'object') continue;
      stats.legacyFilesFound += 1;
      const period = inferFilePeriod(file);
      if (!period) {
        stats.unresolvedFiles.push({
          agencyId: String(agency._id),
          key,
          nombre: file.nombre || '',
          driveId: file.driveId || '',
          reason: 'No se pudo inferir un período válido por ruta, nombre o modifiedTime',
        });
        continue;
      }
      const periodKey = `${period.year}-${String(period.month).padStart(2, '0')}`;
      if (!groups.has(periodKey)) groups.set(periodKey, {});
      groups.get(periodKey)[key] = { file, periodKey };
    }

    for (const [period, entries] of groups) {
      stats.periodsFound += 1;
      const existing = await AgencyMonthlyFiles.findOne({ agencyId: agency._id, period })
        .select('archivos')
        .lean();
      const toWrite = {};
      const toUnset = [];
      for (const [key, { file }] of Object.entries(entries)) {
        const existingFile = existing?.archivos?.[key];
        if (existingFile) {
          if (file.driveId && existingFile.driveId === file.driveId) {
            toUnset.push(key);
          } else {
            stats.conflictingFiles.push({
              agencyId: String(agency._id),
              period,
              key,
              legacyDriveId: file.driveId || '',
              monthlyDriveId: existingFile.driveId || '',
              reason: 'Ya existe otro archivo para este tipo y período',
            });
          }
          continue;
        }
        toWrite[key] = {
          ...file,
          periodYear: Number(period.slice(0, 4)),
          periodMonth: Number(period.slice(5, 7)),
        };
        toUnset.push(key);
      }
      stats.filesMigratable += Object.keys(toWrite).length + toUnset.length;
      if (!apply) continue;

      if (Object.keys(toWrite).length) {
        const set = Object.fromEntries(Object.entries(toWrite).map(([key, file]) => [
          `archivos.${key}`,
          file,
        ]));
        const result = await AgencyMonthlyFiles.updateOne(
          { agencyId: agency._id, period },
          {
            $setOnInsert: { agencyId: agency._id, period },
            $set: set,
          },
          { upsert: true, runValidators: true },
        );
        if (result.upsertedCount) stats.recordsCreated += 1;
        stats.filesMigrated += Object.keys(toWrite).length;
      }
      if (toUnset.length) {
        const filter = { _id: agency._id };
        if (agency.updatedAt) filter.updatedAt = agency.updatedAt;
        toUnset.forEach((key) => {
          const driveId = entries[key]?.file?.driveId;
          if (driveId) filter[`archivos.${key}.driveId`] = driveId;
          else filter[`archivos.${key}`] = entries[key]?.file;
        });
        await Agency.collection.updateOne(filter, {
          $unset: Object.fromEntries(toUnset.map((key) => [`archivos.${key}`, ''])),
        });
      }
    }
  }

  if (apply) {
    const result = await AgencyMonthlyFiles.collection.updateMany(
      { $or: [{ carpetaPrincipal: { $exists: true } }, { carpetaBase: { $exists: true } }] },
      { $unset: { carpetaPrincipal: '', carpetaBase: '' } },
    );
    stats.monthlyFolderFieldsRemoved = result.modifiedCount || result.nModified || 0;
  }
  return stats;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Define MONGO_URI o MONGODB_URI before running the migration.');
    process.exitCode = 1;
  } else {
    mongoose.connect(uri, {
      dbName: process.env.MONGODB_DATABASE || 'EFCore',
      autoIndex: false,
    })
      .then(() => migrate({ apply }))
      .then((result) => {
        console.log(JSON.stringify(result));
        process.exitCode = result.unresolvedFiles.length || result.conflictingFiles.length ? 2 : 0;
      })
      .catch((error) => {
        console.error(`Monthly agency-file migration failed: ${error.message}`);
        process.exitCode = 1;
      })
      .finally(async () => {
        await mongoose.disconnect();
      });
  }
}

module.exports = { inferFilePeriod, migrate };
