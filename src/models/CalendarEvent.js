'use strict';

const mongoose = require('mongoose');
const { publishNotificationChange } = require('../services/notificationEvents');

const reminderSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  minutesBefore: {
    type: [{ type: Number, min: 0, max: 525600 }],
    default: [],
    validate: {
      validator: (values) => values.length <= 5 && new Set(values).size === values.length,
      message: 'Must contain at most five unique reminder offsets',
    },
  },
}, { _id: false });

const recurrenceSchema = new mongoose.Schema({
  frequency: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
  interval: { type: Number, min: 1, max: 365, required: true },
  daysOfWeek: { type: [{ type: Number, min: 0, max: 6 }], default: [] },
  endDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, required: true },
}, { _id: false });

const calendarEventSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  type: {
    type: String,
    required: true,
    enum: ['agency_visit', 'document_deadline', 'file_review', 'personal_admin', 'impuestos_verdes'],
  },
  startAt: { type: Date, required: true },
  endAt: {
    type: Date,
    required: true,
    validate: {
      validator(value) {
        return !this.startAt || value > this.startAt;
      },
      message: 'endAt must be later than startAt',
    },
  },
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', default: null },
  consultantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  notes: { type: String, trim: true, maxlength: 4000, default: '' },
  authorized: { type: Boolean, default: true },
  reminders: { type: reminderSchema, default: () => ({}) },
  recurrenceSeriesId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  recurrence: { type: recurrenceSchema, default: null },
  recalendarizationPeriod: {
    type: String,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
    default: null,
  },
  reminderDispatchKeys: { type: [String], default: [], select: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

calendarEventSchema.index({ startAt: 1, endAt: 1, authorized: 1 });
calendarEventSchema.index({ agencyId: 1, startAt: 1 });
calendarEventSchema.index({ consultantId: 1, startAt: 1 });
calendarEventSchema.index(
  { recurrenceSeriesId: 1, recalendarizationPeriod: 1 },
  {
    unique: true,
    partialFilterExpression: {
      recurrenceSeriesId: { $type: 'objectId' },
      recalendarizationPeriod: { $type: 'string' },
    },
  },
);
calendarEventSchema.post('save', publishNotificationChange);
calendarEventSchema.post('findOneAndUpdate', publishNotificationChange);
calendarEventSchema.post('updateOne', publishNotificationChange);
calendarEventSchema.post('updateMany', publishNotificationChange);
calendarEventSchema.post('deleteOne', publishNotificationChange);
calendarEventSchema.post('findOneAndDelete', publishNotificationChange);

module.exports = mongoose.model('CalendarEvent', calendarEventSchema);
