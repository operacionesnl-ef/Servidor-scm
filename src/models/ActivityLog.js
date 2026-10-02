const mongoose = require('mongoose');

const retentionDaysValue = Number(process.env.ACTIVITY_LOG_RETENTION_DAYS || 365);
const retentionDays = Number.isInteger(retentionDaysValue) && retentionDaysValue > 0
  ? retentionDaysValue
  : 365;

const activityLogSchema = new mongoose.Schema(
  {
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    usuarioNombre: { type: String, trim: true },
    usuarioCorreo: { type: String, lowercase: true, trim: true },
    accion: { type: String, required: true, trim: true },
    coalesceKey: { type: String },
    detalle: { type: mongoose.Schema.Types.Mixed, default: null },
    fecha: { type: Date, default: Date.now },
    ultimaFecha: { type: Date, default: Date.now },
    veces: { type: Number, default: 1 },
    ip: { type: String },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: false }
);

activityLogSchema.index({ usuario: 1, _id: -1 });
activityLogSchema.index({ usuario: 1, accion: 1, coalesceKey: 1, ultimaFecha: -1 });
activityLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
