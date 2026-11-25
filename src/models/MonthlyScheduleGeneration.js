'use strict';

const mongoose = require('mongoose');

const scheduleResultSchema = new mongoose.Schema({
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', default: null },
  sourceEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent', required: true },
  targetEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent', default: null },
  recurrenceSeriesId: { type: mongoose.Schema.Types.ObjectId, default: null },
  status: {
    type: String,
    enum: ['preserved', 'rescheduled', 'unscheduled', 'already_scheduled'],
    required: true,
  },
  idealStartAt: { type: Date, required: true },
  scheduledStartAt: { type: Date, default: null },
  scheduledEndAt: { type: Date, default: null },
  reason: { type: String, default: '' },
}, { _id: false });

const monthlyScheduleGenerationSchema = new mongoose.Schema({
  period: {
    type: String,
    required: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
  },
  sourcePeriod: {
    type: String,
    required: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
  },
  sourceSnapshot: { type: String, default: '' },
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed'],
    required: true,
    default: 'processing',
  },
  attempts: { type: Number, min: 1, default: 1 },
  lockToken: { type: String, default: null, select: false },
  lockExpiresAt: { type: Date, default: null, select: false },
  totalEvents: { type: Number, min: 0, default: 0 },
  preservedEvents: { type: Number, min: 0, default: 0 },
  rescheduledEvents: { type: Number, min: 0, default: 0 },
  unscheduledEvents: { type: Number, min: 0, default: 0 },
  existingEvents: { type: Number, min: 0, default: 0 },
  results: { type: [scheduleResultSchema], default: [] },
  error: { type: String, default: '' },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

monthlyScheduleGenerationSchema.index({ period: 1 }, { unique: true });

module.exports = mongoose.model('MonthlyScheduleGeneration', monthlyScheduleGenerationSchema);
