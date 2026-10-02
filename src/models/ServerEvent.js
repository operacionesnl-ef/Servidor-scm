const mongoose = require('mongoose');

const retentionDaysValue = Number(process.env.SERVER_EVENT_RETENTION_DAYS || 180);
const retentionDays = Number.isInteger(retentionDaysValue) && retentionDaysValue > 0
  ? retentionDaysValue
  : 180;

const serverEventSchema = new mongoose.Schema({
  e: {
    type: String,
    enum: ['server_started', 'session_started', 'job_queued', 'job_started', 'job_finished', 'job_recovered'],
    required: true,
  },
  u: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  j: { type: mongoose.Schema.Types.ObjectId },
  s: { type: String },
  c: { type: Number },
  n: { type: Number },
  at: { type: Date, default: Date.now },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
  },
}, { versionKey: false });

serverEventSchema.index({ u: 1, _id: -1 });
serverEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ServerEvent', serverEventSchema);