'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Agency = require('../src/models/Agency');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const Subscription = require('../src/models/Subscription');
const User = require('../src/models/User');
const pushNotificationService = require('../src/services/pushNotificationService');
const { dispatchMonthlyReportReminders } = require('../src/services/monthlyReportReminderWorker');

function listQuery(items) {
  return {
    select() { return this; },
    lean: async () => items,
  };
}

test('monthly report pushes are grouped per audience and dispatched once outside feed reads', async () => {
  const originalMethods = {
    agencyFind: Agency.find,
    monthlyFilesFind: AgencyMonthlyFiles.find,
    subscriptionExists: Subscription.exists,
    userFind: User.find,
    userFindOneAndUpdate: User.findOneAndUpdate,
    sendPushToUser: pushNotificationService.sendPushToUser,
  };
  const deliveries = [];

  Agency.find = () => listQuery([
    { _id: 'agency-1', status: 'activa', consultantId: 'consultant-1' },
    { _id: 'agency-2', status: 'activa', consultantId: 'consultant-1', auxiliaryConsultantId: 'consultant-2' },
  ]);
  AgencyMonthlyFiles.find = () => listQuery([]);
  User.find = () => listQuery([
    { _id: 'admin-1', rol: 'admin' },
    { _id: 'consultant-1', rol: 'consultor' },
    { _id: 'consultant-2', rol: 'consultor' },
  ]);
  Subscription.exists = async () => true;
  User.findOneAndUpdate = async () => ({ _id: 'claimed-user' });
  pushNotificationService.sendPushToUser = async (userId, payload) => {
    deliveries.push({ userId: String(userId), payload });
    return { sent: true };
  };

  try {
    const now = new Date('2026-10-15T12:00:00.000Z');
    const result = await dispatchMonthlyReportReminders(now);
    const duplicate = await dispatchMonthlyReportReminders(now);

    assert.equal(result.pendingAgencies, 2);
    assert.equal(result.sent, 3);
    assert.equal(deliveries.length, 3);
    assert.match(deliveries.find(({ userId }) => userId === 'consultant-1').payload.body, /2 agencias/);
    assert.match(deliveries.find(({ userId }) => userId === 'consultant-2').payload.body, /1 agencia/);
    assert.equal(duplicate.skipped, true);
    assert.equal(deliveries[0].payload.url, '/notificaciones');
  } finally {
    Agency.find = originalMethods.agencyFind;
    AgencyMonthlyFiles.find = originalMethods.monthlyFilesFind;
    Subscription.exists = originalMethods.subscriptionExists;
    User.find = originalMethods.userFind;
    User.findOneAndUpdate = originalMethods.userFindOneAndUpdate;
    pushNotificationService.sendPushToUser = originalMethods.sendPushToUser;
  }
});
