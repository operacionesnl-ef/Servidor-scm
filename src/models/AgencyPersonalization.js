'use strict';

const mongoose = require('mongoose');

const agencyPersonalizationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
    favorite: { type: Boolean, default: false },
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AgencyTag' }],
  },
  { timestamps: true }
);

agencyPersonalizationSchema.index({ userId: 1, agencyId: 1 }, { unique: true });
agencyPersonalizationSchema.index({ agencyId: 1 });
agencyPersonalizationSchema.index({ tags: 1 });

module.exports = mongoose.model('AgencyPersonalization', agencyPersonalizationSchema);
