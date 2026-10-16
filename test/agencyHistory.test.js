'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyHistory = require('../src/models/AgencyHistory');
const { getAgencyHistory } = require('../src/controllers/agencyHistoryController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('returns the most recent agency history with actor and change details', async () => {
  const originals = { exists: Agency.exists, find: AgencyHistory.find };
  const agencyId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const createdAt = new Date('2026-10-14T12:00:00.000Z');
  Agency.exists = async () => true;
  AgencyHistory.find = (filter) => {
    assert.equal(String(filter.agencyId), String(agencyId));
    return {
      sort() { return this; },
      limit(value) { assert.equal(value, 100); return this; },
      populate() { return this; },
      lean: async () => [{
        _id: new mongoose.Types.ObjectId(),
        action: 'agency_updated',
        summary: 'Se actualizaron nombre',
        details: { changes: [{ field: 'nombre', from: 'Norte', to: 'Centro' }] },
        actorId: { _id: actorId, nombre: 'Ana', correo: 'ana@example.com' },
        createdAt,
      }],
    };
  };

  try {
    const res = response();
    await getAgencyHistory({ params: { id: String(agencyId) } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.history[0].actor.name, 'Ana');
    assert.equal(res.body.data.history[0].details.changes[0].to, 'Centro');
    assert.equal(res.body.data.history[0].createdAt, createdAt);
  } finally {
    Agency.exists = originals.exists;
    AgencyHistory.find = originals.find;
  }
});
