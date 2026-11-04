'use strict';

const mongoose = require('mongoose');

const anxImageSchema = new mongoose.Schema({
  imageId: { type: String, required: true, trim: true, maxlength: 100 },
  numero: { type: Number, min: 1, max: 40, required: true },
  registroId: { type: String, required: true, trim: true, maxlength: 100 },
  nombre: { type: String, required: true, trim: true, maxlength: 100 },
  driveFileId: { type: String, required: true, trim: true },
  fileName: { type: String, required: true, trim: true, maxlength: 255 },
  mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
  tamanoBytes: { type: Number, min: 1, required: true },
  checksum: { type: String, trim: true, default: '' },
  fechaSubida: { type: Date, default: Date.now },
  subidoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { _id: false });

const anxSchema = new mongoose.Schema({
  reporteId: { type: String, required: true, unique: true, index: true },
  estado: { type: String, enum: ['pendiente', 'completado', 'cancelado'], default: 'pendiente' },
  imagenes: {
    type: [anxImageSchema],
    validate: [(images) => images.length <= 40, 'ANX admite hasta 40 imágenes.'],
    default: [],
  },
  totalImagenes: { type: Number, min: 0, max: 40, default: 0 },
}, { timestamps: true });

anxSchema.index({ reporteId: 1, 'imagenes.registroId': 1 }, { unique: true });

module.exports = mongoose.model('ANX', anxSchema);
