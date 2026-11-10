'use strict';

const mongoose = require('mongoose');

const generationEventSchema = new mongoose.Schema({
  step: { type: String, required: true, maxlength: 120 },
  status: { type: String, enum: ['queued', 'processing', 'completed', 'failed', 'retrying'], required: true },
  message: { type: String, maxlength: 1000, default: '' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const generationJobSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  type: { type: String, required: true, trim: true, uppercase: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  reportId: { type: String, required: true, trim: true },
  revision: { type: Number, required: true, min: 1 },
  templateVersion: { type: String, trim: true, default: '1' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['queued', 'processing', 'ready', 'failed'], default: 'queued', index: true },
  step: { type: String, default: 'queued', maxlength: 120 },
  attempts: { type: Number, default: 0, min: 0 },
  queuedAt: { type: Date, default: Date.now },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  error: { type: String, maxlength: 1000, default: '' },
  events: { type: [generationEventSchema], default: [] },
}, { timestamps: true, versionKey: false });

generationJobSchema.index({ status: 1, queuedAt: 1 });
generationJobSchema.index({ reportId: 1, revision: 1, type: 1 });

module.exports = mongoose.model('GenerationJob', generationJobSchema);
