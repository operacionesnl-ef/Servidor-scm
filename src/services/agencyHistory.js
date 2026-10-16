'use strict';

const AgencyHistory = require('../models/AgencyHistory');

async function recordAgencyHistory({ agencyId, actor, action, summary, details = null }) {
  if (!agencyId || !actor?._id || !action || !summary) {
    throw new Error('Agency history requires an agency, actor, action and summary.');
  }
  return AgencyHistory.create({
    agencyId,
    actorId: actor._id,
    actorName: actor.nombre,
    actorEmail: actor.correo,
    action,
    summary,
    details,
  });
}

module.exports = { recordAgencyHistory };
