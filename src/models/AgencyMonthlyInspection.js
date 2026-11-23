'use strict';

const mongoose = require('mongoose');

const agencyMonthlyInspectionSchema = new mongoose.Schema({
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  period: {
    type: String,
    required: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
  },
  authorizationStatus: {
    type: String,
    enum: ['pending', 'authorized', 'unauthorized'],
    default: 'pending',
  },
  visitStatus: {
    type: String,
    enum: ['scheduled', 'completed'],
    default: 'scheduled',
  },
  attendanceStatus: {
    type: String,
    enum: ['pending', 'primary', 'auxiliary'],
    default: null,
  },
  attendanceConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  attendanceConfirmedAt: { type: Date, default: null },
  calendarEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent', default: null },
  reminderClaimedAt: { type: Date, default: null, select: false },
  reminderSentAt: { type: Date, default: null, select: false },
  reminderSentTo: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: [],
    select: false,
  },
}, { timestamps: true });

agencyMonthlyInspectionSchema.index({ agencyId: 1, period: 1 }, { unique: true });
agencyMonthlyInspectionSchema.index({ period: 1, visitStatus: 1 });

module.exports = mongoose.model('AgencyMonthlyInspection', agencyMonthlyInspectionSchema);
