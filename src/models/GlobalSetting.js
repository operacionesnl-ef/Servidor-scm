'use strict';

const mongoose = require('mongoose');

const globalSettingSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  year: { type: Number, required: true, min: 2020, max: 2040 },
  month: { type: Number, required: true, min: 1, max: 12 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('GlobalSetting', globalSettingSchema);
