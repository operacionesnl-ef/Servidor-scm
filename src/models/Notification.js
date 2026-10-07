'use strict';

const mongoose = require('mongoose');
const { publishNotificationChange } = require('../services/notificationEvents');

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  severity: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
  audience: { type: String, enum: ['all', 'admin'], default: 'all' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  readBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
  },
}, { timestamps: true });

notificationSchema.index({ audience: 1, createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

notificationSchema.post('save', publishNotificationChange);
notificationSchema.post('findOneAndUpdate', publishNotificationChange);
notificationSchema.post('updateMany', publishNotificationChange);

module.exports = mongoose.model('Notification', notificationSchema);
