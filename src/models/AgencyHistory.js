'use strict';

const mongoose = require('mongoose');

const agencyHistorySchema = new mongoose.Schema({
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorName: { type: String, trim: true },
  actorEmail: { type: String, lowercase: true, trim: true },
  action: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true, maxlength: 240 },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

agencyHistorySchema.index({ agencyId: 1, createdAt: -1 });

module.exports = mongoose.model('AgencyHistory', agencyHistorySchema);
