'use strict';

const mongoose = require('mongoose');

const environmentalAspectSchema = new mongoose.Schema({
  categoryId: { type: String, required: true, trim: true },
  aspectId: { type: String, required: true, trim: true },
  answer: { type: String, enum: ['1', '0', 'NA'], default: null },
  observation: { type: String, trim: true, maxlength: 1000, default: '' },
}, { _id: false });

const imageSchema = new mongoose.Schema({
  imageId: { type: String, required: true, trim: true },
  driveFileId: { type: String, trim: true, default: '' },
  fileName: { type: String, required: true, trim: true, maxlength: 255 },
  mimeType: { type: String, required: true, trim: true, maxlength: 100 },
  sizeBytes: { type: Number, min: 0, default: 0 },
  checksum: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['pending', 'active', 'removed'], default: 'pending' },
  uploadedAt: { type: Date, default: null },
}, { _id: false });

const evidenceSchema = new mongoose.Schema({
  evidenceId: { type: String, required: true, trim: true },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  status: { type: String, enum: ['active', 'removed'], default: 'active' },
  images: { type: [imageSchema], default: [] },
}, { _id: false });

const forReportSchema = new mongoose.Schema({
  reportId: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true, unique: true, select: false },
  type: { type: String, required: true, enum: ['FOR'], default: 'FOR' },
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true, index: true },
  agencyNameSnapshot: { type: String, required: true, trim: true, maxlength: 200 },
  capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['draft', 'completed', 'archived'], default: 'draft', index: true },
  revision: { type: Number, min: 1, default: 1 },
  templateVersion: { type: String, required: true, default: '1.0' },
  generalData: {
    companyName: { type: String, required: true, trim: true, maxlength: 200 },
    inspectionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    observations: { type: String, trim: true, maxlength: 2000, default: '' },
  },
  environmentalAspects: { type: [environmentalAspectSchema], default: [] },
  evidence: { type: [evidenceSchema], default: [] },
  drive: {
    evidenceFolderId: { type: String, trim: true, default: '' },
    generatedFolderId: { type: String, trim: true, default: '' },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, optimisticConcurrency: true });

forReportSchema.index({ agencyId: 1, 'generalData.inspectionDate': 1, createdAt: -1 });

module.exports = mongoose.model('ForReport', forReportSchema);
