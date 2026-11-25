const mongoose = require('mongoose');
const { publishNotificationChange } = require('../services/notificationEvents');

const jobRecipientSchema = new mongoose.Schema({
  agencyId: { type: String, required: true },
  agencyName: { type: String, required: true },
  correo: { type: String, required: true, lowercase: true, trim: true },
  cc: { type: [String], default: [] },
  cco: { type: [String], default: [] },
  attachments: {
    type: [{
      code: String,
      driveId: { type: String, required: true },
      nombre: String,
      optional: { type: Boolean, default: false },
    }],
    default: [],
  },
}, { _id: false });

const jobResultSchema = new mongoose.Schema({
  agencyId: { type: String, required: true },
  agencyName: { type: String, required: true },
  correo: { type: String, required: true },
  cc: { type: [String], default: [] },
  cco: { type: [String], default: [] },
  status: {
    type: String,
    enum: ['pending', 'preparing', 'sending', 'sent', 'failed', 'unknown', 'cancelled'],
    required: true,
  },
  retryable: { type: Boolean, default: false },
  gmailMessageId: String,
  error: String,
  attachedFiles: {
    type: [{ code: String, driveId: String, nombre: String }],
    default: [],
  },
}, { _id: false });

const mailJobSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ownerEmail: { type: String, required: true, lowercase: true, trim: true },
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued',
    index: true,
  },
  templateKey: { type: String, required: true },
  templateName: { type: String, required: true },
  year: { type: Number, required: true },
  month: { type: Number, required: true },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  globalAttachments: { type: [{ driveId: String, nombre: String }], default: [] },
  recipients: { type: [jobRecipientSchema], required: true },
  results: { type: [jobResultSchema], default: [] },
  total: { type: Number, required: true },
  completed: { type: Number, default: 0 },
  currentIndex: { type: Number, default: 0 },
  currentName: { type: String, default: '' },
  encryptedGoogleAccessToken: { type: String, required: true, select: false },
  error: { type: String, default: '' },
  logError: { type: String, default: '' },
  mailLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'MailLog' },
  expiresAt: { type: Date, default: null },
}, { timestamps: true });

mailJobSchema.index({ status: 1, createdAt: 1 });
mailJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

mailJobSchema.post('save', publishNotificationChange);
mailJobSchema.post('findOneAndUpdate', publishNotificationChange);
mailJobSchema.post('updateOne', publishNotificationChange);
mailJobSchema.post('updateMany', publishNotificationChange);

module.exports = mongoose.model('MailJob', mailJobSchema);