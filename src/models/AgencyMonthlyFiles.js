'use strict';

const mongoose = require('mongoose');

const monthlyFileSchema = new mongoose.Schema({
  nombre: { type: String, trim: true, maxlength: 255 },
  ruta: { type: String, trim: true, maxlength: 2048 },
  driveId: { type: String, trim: true, maxlength: 2048 },
  pseudoPath: { type: [String], default: undefined },
  path: { type: String, trim: true, maxlength: 4096 },
  sizeBytes: { type: Number, min: 0, default: null },
  mimeType: { type: String, trim: true, maxlength: 255, default: '' },
  modifiedTime: { type: Date, default: null },
  periodYear: { type: Number, min: 1900, max: 2100 },
  periodMonth: { type: Number, min: 1, max: 12 },
}, { _id: false });

const agencyMonthlyFilesSchema = new mongoose.Schema({
  agencyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agency',
    required: true,
  },
  period: {
    type: String,
    required: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
  },
  archivos: {
    archivo1: monthlyFileSchema,
    archivo2: monthlyFileSchema,
    archivo3: monthlyFileSchema,
    archivo4: monthlyFileSchema,
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

agencyMonthlyFilesSchema.index({ agencyId: 1, period: 1 }, { unique: true });
agencyMonthlyFilesSchema.index({ period: 1, agencyId: 1 });

module.exports = mongoose.model('AgencyMonthlyFiles', agencyMonthlyFilesSchema);
