const mongoose = require('mongoose');

const sentEmailSchema = new mongoose.Schema(
  {
    agencia: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
    correo1Status: {
      type: String,
      enum: ['enviado', 'fallido', 'pendiente', 'rebotado'],
      default: 'pendiente',
    },
    correo2Status: {
      type: String,
      enum: ['enviado', 'fallido', 'pendiente', 'rebotado'],
      default: 'pendiente',
    },
    mes: { type: Number, required: true, min: 1, max: 12 },
    anio: { type: Number, required: true },
    fechaEnvio: { type: Date },
    correoOrigen: { type: String, required: true, lowercase: true, trim: true },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SentEmail', sentEmailSchema);
