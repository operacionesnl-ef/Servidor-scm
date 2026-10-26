'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyHistory = require('../src/models/AgencyHistory');
const Notification = require('../src/models/Notification');
const Subscription = require('../src/models/Subscription');
const User = require('../src/models/User');
const { createAgency } = require('../src/controllers/agencyController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('creating an agency assigned to a consultant saves a private deep-linked notice', async () => {
  const originals = {
    agencyCreate: Agency.create,
    userExists: User.exists,
    historyCreate: AgencyHistory.create,
    notificationFindOneAndUpdate: Notification.findOneAndUpdate,
    subscriptionExists: Subscription.exists,
  };
  const consultantId = new mongoose.Types.ObjectId();
  const agencyId = new mongoose.Types.ObjectId();
  let persistedNotice;
  User.exists = async () => true;
  Agency.create = async (input) => ({
    ...input,
    _id: agencyId,
    updatedAt: new Date('2026-10-22T12:00:00.000Z'),
  });
  AgencyHistory.create = async (entry) => entry;
  Notification.findOneAndUpdate = async (_filter, update) => {
    persistedNotice = update.$setOnInsert;
    return { _id: new mongoose.Types.ObjectId(), ...persistedNotice };
  };
  Subscription.exists = async () => false;

  try {
    const res = response();
    await createAgency({
      user: { _id: new mongoose.Types.ObjectId(), rol: 'admin', nombre: 'Administración' },
      body: {
        nombre: 'Agencia Norte',
        entidadFederativa: 'Nuevo León',
        consultantId: String(consultantId),
      },
    }, res, (error) => { throw error; });

    assert.equal(res.statusCode, 201);
    assert.equal(persistedNotice.audience, 'personal');
    assert.equal(String(persistedNotice.recipientUserId), String(consultantId));
    assert.equal(persistedNotice.notificationType, 'agency_assigned');
    assert.equal(persistedNotice.actionUrl, `/agencias/${agencyId}`);
    assert.match(persistedNotice.idempotencyKey, new RegExp(`agency:${agencyId}:assigned:`));
  } finally {
    Agency.create = originals.agencyCreate;
    User.exists = originals.userExists;
    AgencyHistory.create = originals.historyCreate;
    Notification.findOneAndUpdate = originals.notificationFindOneAndUpdate;
    Subscription.exists = originals.subscriptionExists;
  }
});
