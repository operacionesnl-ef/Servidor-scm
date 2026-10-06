const mongoose = require('mongoose');
const { logEvent, logDatabaseConnected } = require('../utils/consoleLogger');

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('Define MONGO_URI o MONGODB_URI para conectar MongoDB.');
    }

    const conn = await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DATABASE || 'EFCore',
    });
    logDatabaseConnected(conn.connection.host);
  } catch (error) {
    logEvent('database_connection_failed', { message: error.message });
    process.exit(1);
  }
};

module.exports = connectDB;
