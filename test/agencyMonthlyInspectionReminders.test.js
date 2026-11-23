'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyMonthlyInspection = require('../src/models/AgencyMonthlyInspection');
const User = require('../src/models/User');
const pushNotificationService = require('../src/services/pushNotificationService');
const { dispatchMonthlyInspectionReminders } = require('../src/services/agencyMonthlyInspectionReminders');

test('monthly inspection reminder reaches both consultants with an auxiliary-specific message', async () => {
  const originals = {
    agencyFind: Agency.find,
    inspectionFindOneAndUpdate: AgencyMonthlyInspection.findOneAndUpdate,
    inspectionUpdateOne: AgencyMonthlyInspection.updateOne,
    userExists: User.exists,
    sendPushToUser: pushNotificationService.sendPushToUser,
  };
  const agencyId = new mongoose.Types.ObjectId();
  const principalId = new mongoose.Types.ObjectId();
  const auxiliaryId = new mongoose.Types.ObjectId();
  const agency = {
    _id: agencyId,
    nombre: 'Agencia Compartida',
    consultantId: principalId,
    auxiliaryConsultantId: auxiliaryId,
  };
  const record = { _id: new mongoose.Types.ObjectId(), reminderSentTo: [] };
  const sentUsers = [];
  const sentPayloads = [];

  Agency.find = () => ({
    select() { return this; },
    lean: async () => [agency],
  });
  AgencyMonthlyInspection.updateOne = async (_filter, update) => {
    if (update.$addToSet?.reminderSentTo) {
      record.reminderSentTo.push(update.$addToSet.reminderSentTo);
    }
    return { modifiedCount: 1 };
  };
  AgencyMonthlyInspection.findOneAndUpdate = () => ({
    select() { return this; },
    then(resolve) { return Promise.resolve(record).then(resolve); },
  });
  User.exists = async () => true;
  pushNotificationService.sendPushToUser = async (userId, payload) => {
    sentUsers.push(String(userId));
    sentPayloads.push(payload);
    return { total: 1, sent: 1 };
  };

  try {
    const result = await dispatchMonthlyInspectionReminders(new Date('2026-11-23T12:00:00.000Z'));

    assert.equal(result.dispatched, 1);
    assert.deepEqual(new Set(sentUsers), new Set([String(principalId), String(auxiliaryId)]));
    const auxiliaryNotice = sentPayloads.find((payload) => payload.title.includes('Auxiliar'));
    assert.match(auxiliaryNotice.body, /confirma quién asistirá/i);
    assert.equal(record.reminderSentTo.length, 2);
  } finally {
    Agency.find = originals.agencyFind;
    AgencyMonthlyInspection.findOneAndUpdate = originals.inspectionFindOneAndUpdate;
    AgencyMonthlyInspection.updateOne = originals.inspectionUpdateOne;
    User.exists = originals.userExists;
    pushNotificationService.sendPushToUser = originals.sendPushToUser;
  }
});
