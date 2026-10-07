'use strict';

const mongoose = require('mongoose');
const { publishNotificationChange } = require('../services/notificationEvents');

const agencyRefreshResultSchema = new mongoose.Schema({
  agencyId: { type: String, required: true },
  agencyName: { type: String, required: true },
  correo: { type: String, default: '' },
  entidadFederativa: { type: String, default: '' },
  agencyStatus: { type: String, default: 'activa' },
  status: { type: String, enum: ['updated', 'issues', 'failed', 'skipped'], required: true },
  missingKeys: { type: [String], default: [] },
  files: { type: mongoose.Schema.Types.Mixed, default: {} },
  checks: { type: [mongoose.Schema.Types.Mixed], default: [] },
  error: { type: String, default: '' },
  missingRoot: { type: Boolean, default: false },
}, { _id: false });

const agencyRefreshJobSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ownerEmail: { type: String, required: true, lowercase: true, trim: true },
  jobType: { type: String, enum: ['refresh', 'integrity'], default: 'refresh', index: true },
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'completed_with_issues', 'failed'],
    default: 'queued',
    index: true,
  },
  year: { type: Number, required: true },
  month: { type: Number, required: true },
  agencyIds: { type: [String], required: true },
  results: { type: [agencyRefreshResultSchema], default: [] },
  total: { type: Number, required: true },
  completed: { type: Number, default: 0 },
  currentName: { type: String, default: '' },
  scannedFiles: { type: Number, default: 0 },
  encryptedGoogleAccessToken: { type: String, required: true, select: false },
  error: { type: String, default: '' },
  expiresAt: { type: Date, default: null },
}, { timestamps: true });

agencyRefreshJobSchema.index({ owner: 1, jobType: 1, status: 1, createdAt: -1 });
agencyRefreshJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

agencyRefreshJobSchema.post('save', publishNotificationChange);
agencyRefreshJobSchema.post('findOneAndUpdate', publishNotificationChange);
agencyRefreshJobSchema.post('updateOne', publishNotificationChange);
agencyRefreshJobSchema.post('updateMany', publishNotificationChange);

module.exports = mongoose.model('AgencyRefreshJob', agencyRefreshJobSchema);
