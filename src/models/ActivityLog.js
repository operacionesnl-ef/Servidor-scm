const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    accion: { type: String, required: true, trim: true },
    detalle: { type: mongoose.Schema.Types.Mixed, default: null },
    fecha: { type: Date, default: Date.now },
    ip: { type: String },
  },
  { timestamps: false }
);

module.exports = mongoose.model('ActivityLog', activityLogSchema);
