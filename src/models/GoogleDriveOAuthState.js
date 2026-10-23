'use strict';

const mongoose = require('mongoose');

const googleDriveOAuthStateSchema = new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

googleDriveOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GoogleDriveOAuthState', googleDriveOAuthStateSchema);
