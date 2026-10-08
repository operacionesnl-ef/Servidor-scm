'use strict';

const mongoose = require('mongoose');

const AGENCY_TAG_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

const agencyTagSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    nameKey: { type: String, required: true, unique: true },
    color: { type: String, required: true, enum: AGENCY_TAG_COLORS },
    allowedRoles: {
      type: [{ type: String, enum: ['developer', 'admin', 'user'] }],
      required: true,
      validate: (roles) => roles.length > 0,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgencyTag', agencyTagSchema);
module.exports.AGENCY_TAG_COLORS = AGENCY_TAG_COLORS;
