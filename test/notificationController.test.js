'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyRefreshJob = require('../src/models/AgencyRefreshJob');
const MailJob = require('../src/models/MailJob');
const Notification = require('../src/models/Notification');
const {
  getNotifications,
  publishGlobalNotification,
} = require('../src/controllers/notificationController');

function listQuery(items) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('notification feed limits process visibility to the authenticated user', async () => {
  const userId = new mongoose.Types.ObjectId();
  const originalMethods = {
    agencyFind: Agency.find,
    notificationFind: Notification.find,
    refreshFind: AgencyRefreshJob.find,
    mailFind: MailJob.find,
  };
  let refreshFilter;
  let mailFilter;
  let notificationFilter;

  Agency.find = () => listQuery([]);
  Notification.find = (filter) => {
    notificationFilter = filter;
    return listQuery([]);
  };
  AgencyRefreshJob.find = (filter) => {
    refreshFilter = filter;
    return listQuery([]);
  };
  MailJob.find = (filter) => {
    mailFilter = filter;
    return listQuery([]);
  };

  try {
    const res = response();
    await getNotifications({ user: { _id: userId, rol: 'user' } }, res, (error) => { throw error; });

    assert.deepEqual(refreshFilter.owner, userId);
    assert.deepEqual(mailFilter.owner, userId);
    assert.equal(notificationFilter.audience, 'all');
    assert.equal(res.body.unreadCount, 0);
  } finally {
    Agency.find = originalMethods.agencyFind;
    Notification.find = originalMethods.notificationFind;
    AgencyRefreshJob.find = originalMethods.refreshFind;
    MailJob.find = originalMethods.mailFind;
  }
});

test('notification feed exposes administrative process queries only to admin roles', async () => {
  const originalMethods = {
    agencyFind: Agency.find,
    notificationFind: Notification.find,
    refreshFind: AgencyRefreshJob.find,
    mailFind: MailJob.find,
  };
  let refreshFilter;
  let notificationFilter;

  Agency.find = () => listQuery([]);
  Notification.find = (filter) => {
    notificationFilter = filter;
    return listQuery([]);
  };
  AgencyRefreshJob.find = (filter) => {
    refreshFilter = filter;
    return listQuery([]);
  };
  MailJob.find = () => listQuery([]);

  try {
    const res = response();
    await getNotifications({ user: { _id: 'admin-id', rol: 'admin' } }, res, (error) => { throw error; });

    assert.equal(Object.hasOwn(refreshFilter, 'owner'), false);
    assert.deepEqual(notificationFilter.audience, { $in: ['all', 'admin'] });
  } finally {
    Agency.find = originalMethods.agencyFind;
    Notification.find = originalMethods.notificationFind;
    AgencyRefreshJob.find = originalMethods.refreshFind;
    MailJob.find = originalMethods.mailFind;
  }
});

test('global announcement endpoint validates and persists developer notices', async () => {
  const originalCreate = Notification.create;
  let savedNotice;
  Notification.create = async (payload) => {
    savedNotice = payload;
    return {
      ...payload,
      _id: 'notice-id',
      createdAt: new Date('2026-10-05T12:00:00Z'),
    };
  };

  try {
    const res = response();
    await publishGlobalNotification({
      user: { _id: 'developer-id' },
      body: { title: '  Mantenimiento  ', message: '  Hoy a las 22:00  ', severity: 'high', audience: 'all' },
    }, res, (error) => { throw error; });

    assert.equal(res.statusCode, 201);
    assert.equal(savedNotice.title, 'Mantenimiento');
    assert.equal(savedNotice.message, 'Hoy a las 22:00');
    assert.equal(savedNotice.createdBy, 'developer-id');

    const invalid = response();
    await publishGlobalNotification({
      user: { _id: 'developer-id' },
      body: { title: '', message: 'Contenido', severity: 'low', audience: 'all' },
    }, invalid, (error) => { throw error; });
    assert.equal(invalid.statusCode, 400);
  } finally {
    Notification.create = originalCreate;
  }
});
