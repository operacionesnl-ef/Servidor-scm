'use strict';

const Agency = require('../models/Agency');
const AgencyMonthlyFiles = require('../models/AgencyMonthlyFiles');

const FILE_KEYS = ['archivo1', 'archivo2', 'archivo3', 'archivo4'];
const BATCH_SIZE = 500;

async function sanitizeLegacyAgencyFiles({ apply = false } = {}) {
  const stats = {
    agenciesScanned: 0,
    agenciesWithLegacyArchive: 0,
    agenciesWithDuplicateFiles: 0,
    duplicateFileSlots: 0,
    agenciesWithNullFileSlots: 0,
    nullFileSlots: 0,
    legacySlotsWithoutDriveId: 0,
    agenciesWithFolderReferences: 0,
    folderReferences: 0,
    monthlyRecordsWithNullSlots: 0,
    monthlyNullFileSlots: 0,
    monthlyRecordsSanitized: 0,
    monthlyRecordsChangedDuringRun: 0,
    agenciesWouldSanitize: 0,
    agenciesSanitized: 0,
    agenciesChangedDuringRun: 0,
    applied: apply,
  };
  let operations = [];
  let monthlyOperations = [];

  const flush = async () => {
    if (!operations.length) return;
    const result = await Agency.collection.bulkWrite(operations, { ordered: false });
    const matched = result.matchedCount ?? result.nMatched ?? 0;
    stats.agenciesSanitized += result.modifiedCount ?? result.nModified ?? 0;
    stats.agenciesChangedDuringRun += operations.length - matched;
    operations = [];
  };

  const flushMonthly = async () => {
    if (!monthlyOperations.length) return;
    const result = await AgencyMonthlyFiles.collection.bulkWrite(monthlyOperations, { ordered: false });
    const matched = result.matchedCount ?? result.nMatched ?? 0;
    stats.monthlyRecordsSanitized += result.modifiedCount ?? result.nModified ?? 0;
    stats.monthlyRecordsChangedDuringRun += monthlyOperations.length - matched;
    monthlyOperations = [];
  };

  const cursor = Agency.find({ archivos: { $exists: true } })
    .select('_id archivos updatedAt')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  for await (const agency of cursor) {
    stats.agenciesScanned += 1;
    const archive = agency.archivos && typeof agency.archivos === 'object'
      ? agency.archivos
      : {};
    const legacySlots = FILE_KEYS.filter((key) => {
      const file = archive[key];
      return Boolean(file && (file.nombre || file.ruta || file.driveId));
    });
    const nullSlots = FILE_KEYS.filter((key) => (
      Object.hasOwn(archive, key) && archive[key] === null
    ));
    const folderReferences = ['carpetaPrincipal', 'carpetaBase']
      .filter((key) => Boolean(archive[key]));

    stats.agenciesWithLegacyArchive += 1;
    if (folderReferences.length) stats.agenciesWithFolderReferences += 1;
    stats.folderReferences += folderReferences.length;
    if (nullSlots.length) stats.agenciesWithNullFileSlots += 1;
    stats.nullFileSlots += nullSlots.length;
    const driveIds = new Set(legacySlots.map((key) => archive[key].driveId).filter(Boolean));
    stats.legacySlotsWithoutDriveId += legacySlots.filter((key) => !archive[key].driveId).length;
    if (!driveIds.size && !nullSlots.length) continue;

    let duplicateSlots = [];
    if (driveIds.size) {
      const monthlyRecords = await AgencyMonthlyFiles.find({ agencyId: agency._id })
        .select('archivos')
        .lean();
      const archivedDriveIds = new Set(
        monthlyRecords.flatMap((record) => FILE_KEYS.map((key) => record.archivos?.[key]?.driveId))
          .filter(Boolean),
      );
      duplicateSlots = legacySlots.filter((key) => archivedDriveIds.has(archive[key].driveId));
    }
    const slotsToUnset = [...new Set([...duplicateSlots, ...nullSlots])];
    if (!slotsToUnset.length) continue;
    if (duplicateSlots.length) stats.agenciesWithDuplicateFiles += 1;
    stats.duplicateFileSlots += duplicateSlots.length;
    stats.agenciesWouldSanitize += 1;

    if (apply) {
      const filter = { _id: agency._id };
      if (agency.updatedAt) filter.updatedAt = agency.updatedAt;
      duplicateSlots.forEach((key) => {
        filter[`archivos.${key}.driveId`] = archive[key].driveId;
      });
      nullSlots.forEach((key) => {
        filter[`archivos.${key}`] = { $type: 10 };
      });
      const unset = Object.fromEntries(slotsToUnset.map((key) => [`archivos.${key}`, '']));
      operations.push({
        updateOne: {
          filter,
          update: { $unset: unset },
        },
      });
      if (operations.length >= BATCH_SIZE) await flush();
    }
  }

  const nullMonthlySlotFilter = {
    $or: FILE_KEYS.map((key) => ({ [`archivos.${key}`]: { $type: 10 } })),
  };
  const monthlyCursor = AgencyMonthlyFiles.find(nullMonthlySlotFilter)
    .select('_id archivos')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const record of monthlyCursor) {
    const nullSlots = FILE_KEYS.filter((key) => (
      Object.hasOwn(record.archivos || {}, key) && record.archivos[key] === null
    ));
    if (!nullSlots.length) continue;
    stats.monthlyRecordsWithNullSlots += 1;
    stats.monthlyNullFileSlots += nullSlots.length;
    if (!apply) continue;

    monthlyOperations.push({
      updateOne: {
        filter: {
          _id: record._id,
          ...Object.fromEntries(nullSlots.map((key) => [`archivos.${key}`, { $type: 10 }])),
        },
        update: {
          $unset: Object.fromEntries(nullSlots.map((key) => [`archivos.${key}`, ''])),
        },
      },
    });
    if (monthlyOperations.length >= BATCH_SIZE) await flushMonthly();
  }

  if (apply) await flush();
  if (apply) await flushMonthly();
  return stats;
}

if (require.main === module) {
  require('../config/env');
  const mongoose = require('mongoose');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Define MONGO_URI o MONGODB_URI before running the sanitizer.');
    process.exitCode = 1;
  } else {
    mongoose.connect(uri, {
      dbName: process.env.MONGODB_DATABASE || 'EFCore',
      autoIndex: false,
    })
      .then(() => sanitizeLegacyAgencyFiles({ apply: process.argv.includes('--apply') }))
      .then((stats) => {
        console.log(JSON.stringify(stats));
      })
      .catch((error) => {
        console.error(`Legacy agency-file sanitization failed: ${error.message}`);
        process.exitCode = 1;
      })
      .finally(async () => {
        await mongoose.disconnect();
      });
  }
}

module.exports = { sanitizeLegacyAgencyFiles };
