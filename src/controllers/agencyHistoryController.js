'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyHistory = require('../models/AgencyHistory');
const { success } = require('../utils/response');

async function getAgencyHistory(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid agency ID' });
  }
  try {
    if (!await Agency.exists({ _id: req.params.id })) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    const entries = await AgencyHistory.find({ agencyId: req.params.id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .populate('actorId', 'nombre correo')
      .lean();
    return success(res, {
      history: entries.map((entry) => ({
        id: String(entry._id),
        action: entry.action,
        summary: entry.summary,
        details: entry.details,
        actor: entry.actorId ? {
          id: String(entry.actorId._id),
          name: entry.actorId.nombre || entry.actorName || '',
          email: entry.actorId.correo || entry.actorEmail || '',
        } : {
          name: entry.actorName || '',
          email: entry.actorEmail || '',
        },
        createdAt: entry.createdAt,
      })),
    }, 'Agency history fetched');
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAgencyHistory };
