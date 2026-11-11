'use strict';

const mongoose = require('mongoose');
const {
  CHECK_VALUES,
  STATUS_OPTIONS,
  TYPE_FIELDS,
} = require('../revOptions');

const extinguisherSchema = new mongoose.Schema({
  n: { type: Number, min: 1, required: true },
  pqs: { type: String, enum: ['', '1'], default: '' },
  co2: { type: String, enum: ['', '1'], default: '' },
  agua: { type: String, enum: ['', '1'], default: '' },
  tipod: { type: String, enum: ['', '1'], default: '' },
  tipok: { type: String, enum: ['', '1'], default: '' },
  capacidad: { type: Number, min: 0, default: null },
  pintura: { type: String, enum: CHECK_VALUES, default: '' },
  golpes: { type: String, enum: CHECK_VALUES, default: '' },
  adhesivo: { type: String, enum: CHECK_VALUES, default: '' },
  transporte: { type: String, enum: CHECK_VALUES, default: '' },
  disparo: { type: String, enum: CHECK_VALUES, default: '' },
  presion: { type: String, enum: CHECK_VALUES, default: '' },
  manometro: { type: String, enum: CHECK_VALUES, default: '' },
  manguera: { type: String, enum: CHECK_VALUES, default: '' },
  ring: { type: String, enum: CHECK_VALUES, default: '' },
  boquilla: { type: String, enum: CHECK_VALUES, default: '' },
  senalizacion: { type: String, enum: CHECK_VALUES, default: '' },
  libre: { type: String, enum: CHECK_VALUES, default: '' },
  limpio: { type: String, enum: CHECK_VALUES, default: '' },
  fecha_carga: { type: String, trim: true, default: '' },
  fecha_vencimiento: { type: String, trim: true, default: '' },
  status: { type: String, enum: STATUS_OPTIONS, default: '' },
  observaciones: { type: String, trim: true, maxlength: 2000, default: 'Sin Observaciones' },
  ubicacion: { type: String, trim: true, maxlength: 500, default: '' },
}, { _id: false, strict: 'throw' });

extinguisherSchema.pre('validate', function validateExtinguisherType(next) {
  const selectedTypes = TYPE_FIELDS.filter((field) => this[field] === '1');
  if (selectedTypes.length > 1) {
    this.invalidate('pqs', 'Solo se puede seleccionar un tipo de extintor.');
  }
  next();
});

const revReportSchema = new mongoose.Schema({
  reportId: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true, unique: true, select: false },
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true, index: true },
  agencyNameSnapshot: { type: String, required: true, trim: true, maxlength: 200 },
  agencyLegalNameSnapshot: { type: String, trim: true, maxlength: 200, default: '' },
  agencyAddressSnapshot: { type: String, trim: true, maxlength: 500, default: '' },
  agencyBrandSnapshot: { type: String, trim: true, maxlength: 80, default: '' },
  agencyFileNameCodeSnapshot: { type: String, trim: true, maxlength: 60, default: '' },
  reviewIntervalMonths: { type: Number, min: 1, max: 120, default: 1 },
  revision: { type: Number, min: 1, default: 1 },
  generalData: {
    inspectionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    responsible: { type: String, trim: true, maxlength: 200, default: '' },
  },
  extinguishers: {
    type: [extinguisherSchema],
    default: [],
    validate: {
      validator: (extinguishers) => extinguishers.length <= 80,
      message: 'El REV permite un máximo de 80 extintores.',
    },
  },
  generatedExcel: {
    status: { type: String, enum: ['not_requested', 'queued', 'processing', 'ready', 'failed'], default: 'not_requested' },
    reportRevision: { type: Number, min: 0, default: 0 },
    templateVersion: { type: String, trim: true, default: '1.0' },
    driveFileId: { type: String, trim: true, default: '' },
    downloadFileName: { type: String, trim: true, default: '' },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    generatedAt: { type: Date, default: null },
    error: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  drive: { generatedFolderId: { type: String, trim: true, default: '' } },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, optimisticConcurrency: true });

revReportSchema.index({ agencyId: 1, 'generalData.inspectionDate': 1, createdAt: -1 });

module.exports = mongoose.model('RevReport', revReportSchema);
