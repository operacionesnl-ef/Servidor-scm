const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true },
    correo: { type: String, required: true, unique: true, lowercase: true, trim: true },
    rol: {
      type: String,
      enum: ['developer', 'admin', 'user'],
      default: 'user',
    },
    status: {
      type: String,
      enum: ['activo', 'inactivo', 'suspendido'],
      default: 'activo',
    },
    autenticacion: {
      proveedor: { type: String, enum: ['local', 'google', 'microsoft'], default: 'local' },
      passwordHash: { type: String },
      ultimoAcceso: { type: Date },
    },
    tokenUnico: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
