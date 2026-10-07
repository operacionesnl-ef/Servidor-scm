const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  lastActivityAt: { type: Date, required: true },
  absoluteExpiresAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

module.exports = mongoose.model('AuthSession', authSessionSchema);
