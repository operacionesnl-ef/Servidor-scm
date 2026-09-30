const mongoose = require('mongoose');

const archivoSchema = new mongoose.Schema(
  {
    nombre: { type: String, trim: true },
    ruta: { type: String, trim: true },
  },
  { _id: false }
);

const agencySchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true },
    correo: { type: String, required: true, lowercase: true, trim: true },
    entidadFederativa: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['activa', 'inactiva', 'suspendida'],
      default: 'activa',
    },
    archivos: {
      carpetaPrincipal: { type: String, trim: true },
      archivo1: archivoSchema,
      archivo2: archivoSchema,
      archivo3: archivoSchema,
      archivo4: archivoSchema,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Agency', agencySchema);
