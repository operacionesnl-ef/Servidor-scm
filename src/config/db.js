const mongoose = require('mongoose');
const { logEvent, logDatabaseConnected } = require('../utils/consoleLogger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    logDatabaseConnected(conn.connection.host);
  } catch (error) {
    logEvent('database_connection_failed', { message: error.message });
    process.exit(1);
  }
};

module.exports = connectDB;
