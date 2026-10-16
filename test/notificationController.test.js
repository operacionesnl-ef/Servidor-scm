'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyRefreshJob = require('../src/models/AgencyRefreshJob');
const MailJob = require('../src/models/MailJob');
const Notification = require('../src/models/Notification');
const Subscription = require('../src/models/Subscription');
const GlobalSetting = require('../src/models/GlobalSetting');
const User = require('../src/models/User');
const webpush = require('web-push');
const { EventEmitter } = require('node:events');
const {
  getNotifications,
  hideNotificationFromQuickView,
  markNotificationRead,
  publishGlobalNotification,
  streamNotificationEvents,
} = require('../src/controllers/notificationController');
const { getMexicoPeriod } = require('../src/utils/notificationUtils');
const { publishNotificationChange } = require('../src/services/notificationEvents');

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
    globalSettingFindById: GlobalSetting.findById,
    notificationFind: Notification.find,
    refreshFind: AgencyRefreshJob.find,
    mailFind: MailJob.find,
  };
  let refreshFilter;
  let mailFilter;
  let notificationFilter;

  Agency.find = () => listQuery([]);
  GlobalSetting.findById = () => ({ lean: async () => ({ year: 2026, month: 8 }) });
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
    const expectedPeriod = getMexicoPeriod(new Date());
    assert.deepEqual(
      { year: res.body.period.year, month: res.body.period.month },
      expectedPeriod,
    );
  } finally {
    Agency.find = originalMethods.agencyFind;
    GlobalSetting.findById = originalMethods.globalSettingFindById;
    Notification.find = originalMethods.notificationFind;
    AgencyRefreshJob.find = originalMethods.refreshFind;
    MailJob.find = originalMethods.mailFind;
  }
});

test('notification feed exposes administrative process queries only to admin roles', async () => {
  const originalMethods = {
    agencyFind: Agency.find,
    globalSettingFindById: GlobalSetting.findById,
    notificationFind: Notification.find,
    refreshFind: AgencyRefreshJob.find,
    mailFind: MailJob.find,
  };
  let refreshFilter;
  let notificationFilter;

  Agency.find = () => listQuery([]);
  GlobalSetting.findById = () => ({ lean: async () => null });
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
    GlobalSetting.findById = originalMethods.globalSettingFindById;
    Notification.find = originalMethods.notificationFind;
    AgencyRefreshJob.find = originalMethods.refreshFind;
    MailJob.find = originalMethods.mailFind;
  }
});

test('quick notification feed includes every unread item and only three visible read items', async () => {
  const originalMethods = {
    agencyFind: Agency.find,
    globalSettingFindById: GlobalSetting.findById,
    notificationFind: Notification.find,
    refreshFind: AgencyRefreshJob.find,
    mailFind: MailJob.find,
  };
  const notices = [
    { _id: '507f1f77bcf86cd799439001', title: 'Unread 1', message: 'One', severity: 'low', readBy: [], createdAt: new Date('2026-10-06T00:00:00Z') },
    { _id: '507f1f77bcf86cd799439002', title: 'Unread 2', message: 'Two', severity: 'low', readBy: [], createdAt: new Date('2026-10-05T00:00:00Z') },
    ...Array.from({ length: 4 }, (_, index) => ({
      _id: `507f1f77bcf86cd79943900${index + 3}`,
      title: `Read ${index}`,
      message: 'Read notice',
      severity: 'low',
      readBy: ['user-id'],
      createdAt: new Date(Date.UTC(2026, 9, index + 1)),
    })),
  ];
  Agency.find = () => listQuery([]);
  GlobalSetting.findById = () => ({ lean: async () => null });
  Notification.find = () => listQuery(notices);
  AgencyRefreshJob.find = () => listQuery([]);
  MailJob.find = () => listQuery([]);

  try {
    const res = response();
    await getNotifications({
      query: { view: 'quick' },
      user: { _id: 'user-id', rol: 'user', readNotificationIds: [], quickViewHiddenNotifications: ['507f1f77bcf86cd799439001'] },
    }, res, (error) => { throw error; });

    assert.equal(res.body.items.length, 4);
    assert.equal(res.body.items.filter((item) => !item.read).length, 1);
    assert.equal(res.body.items.filter((item) => item.read).length, 3);
    assert.equal(res.body.items.some((item) => item.id === '507f1f77bcf86cd799439001'), false);
    assert.equal(res.body.unreadCount, 2);
  } finally {
    Agency.find = originalMethods.agencyFind;
    GlobalSetting.findById = originalMethods.globalSettingFindById;
    Notification.find = originalMethods.notificationFind;
    AgencyRefreshJob.find = originalMethods.refreshFind;
    MailJob.find = originalMethods.mailFind;
  }
});

test('notification SSE broadcasts persisted changes without an initial redundant refresh', async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const writes = [];
  res.destroyed = false;
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  res.write = (value) => { writes.push(value); return true; };

  streamNotificationEvents(req, res);
  assert.equal(writes.some((event) => event.includes('event: change')), false);
  publishNotificationChange();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(writes.filter((event) => event.includes('event: change')).length, 1);
  res.destroyed = true;
  res.emit('close');
});

test('hiding a quick-view item stores its id only on the authenticated user', async () => {
  const originalUpdate = User.updateOne;
  let update;
  User.updateOne = async (...args) => { update = args; return { modifiedCount: 1 }; };

  try {
    const res = response();
    await hideNotificationFromQuickView({
      params: { id: 'reminder:2026-10:507f1f77bcf86cd799439011' },
      user: { _id: 'user-id', quickViewHiddenNotifications: [] },
    }, res, (error) => { throw error; });
    assert.deepEqual(update, [
      { _id: 'user-id' },
      { $addToSet: { quickViewHiddenNotifications: 'reminder:2026-10:507f1f77bcf86cd799439011' } },
    ]);
    assert.equal(res.body.success, true);
  } finally {
    User.updateOne = originalUpdate;
  }
});

test('marking a synthetic reminder as read is stored per user', async () => {
  const originalUpdate = User.updateOne;
  let update;
  User.updateOne = async (...args) => { update = args; return { modifiedCount: 1 }; };

  try {
    const res = response();
    await markNotificationRead({
      params: { id: 'reminder:2026-10:507f1f77bcf86cd799439011' },
      user: { _id: 'user-id' },
    }, res, (error) => { throw error; });
    assert.deepEqual(update, [
      { _id: 'user-id' },
      { $addToSet: { readNotificationIds: 'reminder:2026-10:507f1f77bcf86cd799439011' } },
    ]);
    assert.equal(res.body.success, true);
  } finally {
    User.updateOne = originalUpdate;
  }
});

test('global announcement endpoint validates and persists developer notices', async () => {
  const originalCreate = Notification.create;
  const originalUserFind = User.find;
  const originalSubscriptionFind = Subscription.find;
  const originalSendNotification = webpush.sendNotification;
  let savedNotice;
  let recipientFilter;
  let subscriptionFilter;
  const deliveries = [];
  Notification.create = async (payload) => {
    savedNotice = payload;
    return {
      ...payload,
      _id: 'notice-id',
      createdAt: new Date('2026-10-05T12:00:00Z'),
    };
  };
  User.find = (filter) => {
    recipientFilter = filter;
    return listQuery([{ _id: 'active-user-id' }]);
  };
  Subscription.find = (filter) => {
    subscriptionFilter = filter;
    return listQuery([{
      _id: 'device-id',
      endpoint: 'https://push.example/device',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    }]);
  };
  webpush.sendNotification = async (subscription, payload) => {
    deliveries.push({ subscription, payload: JSON.parse(payload) });
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
    assert.deepEqual(recipientFilter, { status: 'activo' });
    assert.deepEqual(subscriptionFilter, { userId: { $in: ['active-user-id'] } });
    assert.equal(res.body.push.sent, 1);
    assert.equal(res.body.push.total, 1);
    assert.deepEqual(deliveries[0].payload, {
      title: 'Mantenimiento',
      body: 'Hoy a las 22:00',
      url: '/notificaciones',
      tag: 'announcement-notice-id',
    });

    const adminNotice = response();
    await publishGlobalNotification({
      user: { _id: 'developer-id' },
      body: { title: 'Solo admins', message: 'Mensaje interno.', severity: 'low', audience: 'admin' },
    }, adminNotice, (error) => { throw error; });
    assert.deepEqual(recipientFilter, {
      status: 'activo',
      rol: { $in: ['admin', 'developer'] },
    });

    const invalid = response();
    await publishGlobalNotification({
      user: { _id: 'developer-id' },
      body: { title: '', message: 'Contenido', severity: 'low', audience: 'all' },
    }, invalid, (error) => { throw error; });
    assert.equal(invalid.statusCode, 400);
  } finally {
    Notification.create = originalCreate;
    User.find = originalUserFind;
    Subscription.find = originalSubscriptionFind;
    webpush.sendNotification = originalSendNotification;
  }
});
