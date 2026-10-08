const mongoose = require('mongoose');
const { logEvent, logDatabaseConnected } = require('../utils/consoleLogger');
const Agency = require('../models/Agency');

const removeUniqueAgencyEmailIndex = async () => {
  let indexes;
  try {
    indexes = await Agency.collection.indexes();
  } catch (error) {
    if (error.code === 26 || error.codeName === 'NamespaceNotFound') return;
    throw error;
  }

  const uniqueEmailIndexes = indexes.filter((index) => (
    index.unique
    && Object.keys(index.key || {}).length === 1
    && Object.hasOwn(index.key, 'correo')
  ));
  for (const index of uniqueEmailIndexes) {
    await Agency.collection.dropIndex(index.name);
    logEvent('agency_email_unique_index_removed', { index: index.name });
  }
};

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('Define MONGO_URI o MONGODB_URI para conectar MongoDB.');
    }

    const conn = await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DATABASE || 'EFCore',
    });
    await removeUniqueAgencyEmailIndex();
    logDatabaseConnected(conn.connection.host);
  } catch (error) {
    logEvent('database_connection_failed', { message: error.message });
    process.exit(1);
  }
};

module.exports = connectDB;
module.exports.removeUniqueAgencyEmailIndex = removeUniqueAgencyEmailIndex;
