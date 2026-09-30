const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema(
  {
    plantillaCorreo1: {
      asunto: { type: String, trim: true },
      cuerpoHtml: { type: String },
      cuerpoTexto: { type: String },
    },
    plantillaCorreo2: {
      asunto: { type: String, trim: true },
      cuerpoHtml: { type: String },
      cuerpoTexto: { type: String },
    },
    version: { type: String, default: '1.0' },
    activa: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Template', templateSchema);
