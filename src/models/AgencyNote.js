'use strict';

const mongoose = require('mongoose');

const agencyNoteSchema = new mongoose.Schema({
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, trim: true, maxlength: 4000 },
}, { timestamps: { createdAt: true, updatedAt: false } });

agencyNoteSchema.index({ agencyId: 1, createdAt: -1 });

module.exports = mongoose.model('AgencyNote', agencyNoteSchema);
