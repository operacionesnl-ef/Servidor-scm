'use strict';

const mongoose = require('mongoose');

const findingSchema = new mongoose.Schema({
  findingId: { type: String, trim: true, maxlength: 100, default: '' },
  area: { type: String, trim: true, maxlength: 200, default: '' },
  element: { type: String, trim: true, maxlength: 2000, default: '' },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  imageNumber: { type: String, trim: true, maxlength: 200, default: '' },
  correctiveAction: { type: String, trim: true, maxlength: 2000, default: '' },
  preventiveAction: { type: String, trim: true, maxlength: 2000, default: '' },
  priority: { type: String, trim: true, maxlength: 30, default: '' },
  responsible: { type: String, trim: true, maxlength: 200, default: '' },
  legalBasis: { type: String, trim: true, maxlength: 2000, required: true },
  findingDate: { type: String, trim: true, default: '' },
  dueDate: { type: String, trim: true, default: '' },
  status: { type: String, trim: true, maxlength: 50, default: '' },
  onTime: { type: String, trim: true, maxlength: 30, default: '' },
  sanction: { type: Number, min: 0, default: null },
}, { _id: false });

const repReportSchema = new mongoose.Schema({
  reportId: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true, unique: true, select: false },
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true, index: true },
  calendarEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent', default: null },
  agencyNameSnapshot: { type: String, required: true, trim: true, maxlength: 200 },
  agencyLegalNameSnapshot: { type: String, trim: true, maxlength: 200, default: '' },
  agencyAddressSnapshot: { type: String, trim: true, maxlength: 500, default: '' },
  agencyStateSnapshot: { type: String, trim: true, maxlength: 100, default: '' },
  agencyBrandSnapshot: { type: String, trim: true, maxlength: 80, default: '' },
  agencyFileNameCodeSnapshot: { type: String, trim: true, maxlength: 60, default: '' },
  status: { type: String, enum: ['draft', 'completed', 'archived'], default: 'draft', index: true },
  revision: { type: Number, min: 1, default: 1 },
  templateVersion: { type: String, required: true, default: '1.0' },
  generalData: {
    inspectionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    visitType: { type: String, enum: ['ordinario', 'extraordinario'], required: true },
    startTime: { type: String, trim: true, default: '' },
    endTime: { type: String, trim: true, default: '' },
    areas: { type: String, trim: true, maxlength: 2000, default: '' },
    city: { type: String, trim: true, maxlength: 200, default: '' },
  },
  findings: { type: [findingSchema], default: [] },
  documents: {
    estudio_iluminacion: { type: String, trim: true, maxlength: 2000, default: '' },
    estudio_ruido: { type: String, trim: true, maxlength: 2000, default: '' },
    permisos_recipientes: { type: String, trim: true, maxlength: 2000, default: '' },
    registro_programa: { type: String, trim: true, maxlength: 2000, default: '' },
    licencia_uso: { type: String, trim: true, maxlength: 2000, default: '' },
    estudio_grado: { type: String, trim: true, maxlength: 2000, default: '' },
    estudio_sustancias: { type: String, trim: true, maxlength: 2000, default: '' },
  },
  generatedExcel: {
    status: {
      type: String,
      enum: ['not_requested', 'queued', 'processing', 'ready', 'failed'],
      default: 'not_requested',
    },
    reportRevision: { type: Number, min: 0, default: 0 },
    templateVersion: { type: String, trim: true, default: '1.0' },
    driveFileId: { type: String, trim: true, default: '' },
    downloadFileName: { type: String, trim: true, default: '' },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    generatedAt: { type: Date, default: null },
    error: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  drive: {
    evidenceFolderId: { type: String, trim: true, default: '' },
    generatedFolderId: { type: String, trim: true, default: '' },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, optimisticConcurrency: true });

repReportSchema.index({ agencyId: 1, 'generalData.inspectionDate': 1, createdAt: -1 });
repReportSchema.index(
  { agencyId: 1, calendarEventId: 1 },
  { unique: true, partialFilterExpression: { calendarEventId: { $type: 'objectId' } } },
);
module.exports = mongoose.model('RepReport', repReportSchema);
