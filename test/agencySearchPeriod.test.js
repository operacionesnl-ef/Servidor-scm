'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const GlobalSetting = require('../src/models/GlobalSetting');
const Notification = require('../src/models/Notification');
const {
  getAgencySearchPeriod,
  updateAgencySearchPeriod,
} = require('../src/controllers/agencyController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('gets the globally stored agency search period without writing to the database', async () => {
  const originalFindById = GlobalSetting.findById;
  const originalFindOneAndUpdate = GlobalSetting.findOneAndUpdate;
  let query;
  GlobalSetting.findById = (id) => {
    query = id;
    return { lean: async () => ({ year: 2026, month: 9 }) };
  };
  GlobalSetting.findOneAndUpdate = () => {
    throw new Error('A GET request must not write to the database.');
  };

  try {
    const res = response();
    await getAgencySearchPeriod({}, res, (error) => { throw error; });
    assert.deepEqual(res.body, { year: 2026, month: 9 });
    assert.equal(query, 'agency-search-period');
  } finally {
    GlobalSetting.findById = originalFindById;
    GlobalSetting.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('uses the current Mexico period when no shared value has been saved', async () => {
  const originalFindById = GlobalSetting.findById;
  GlobalSetting.findById = () => ({ lean: async () => null });

  try {
    const res = response();
    await getAgencySearchPeriod({}, res, (error) => { throw error; });
    assert.deepEqual(Object.keys(res.body).sort(), ['month', 'year']);
    assert.ok(Number.isInteger(res.body.year));
    assert.ok(res.body.month >= 1 && res.body.month <= 12);
  } finally {
    GlobalSetting.findById = originalFindById;
  }
});

test('updates the shared period and publishes one global change notification', async () => {
  const originalMethods = {
    findById: GlobalSetting.findById,
    findOneAndUpdate: GlobalSetting.findOneAndUpdate,
    createNotification: Notification.create,
  };
  let notification;
  GlobalSetting.findById = () => ({ lean: async () => ({ year: 2026, month: 8 }) });
  GlobalSetting.findOneAndUpdate = (filter, update) => ({
    lean: async () => ({ ...update.$set }),
  });
  Notification.create = async (payload) => { notification = payload; };

  try {
    const res = response();
    await updateAgencySearchPeriod({
      user: { _id: 'user-id' },
      body: { year: 2026, month: 9 },
    }, res, (error) => { throw error; });
    assert.deepEqual(res.body, { year: 2026, month: 9 });
    assert.equal(notification.audience, 'all');
    assert.match(notification.message, /09\/2026/);
  } finally {
    GlobalSetting.findById = originalMethods.findById;
    GlobalSetting.findOneAndUpdate = originalMethods.findOneAndUpdate;
    Notification.create = originalMethods.createNotification;
  }
});

test('rejects invalid periods without updating the global setting', async () => {
  const originalFindOneAndUpdate = GlobalSetting.findOneAndUpdate;
  let updated = false;
  GlobalSetting.findOneAndUpdate = () => { updated = true; };

  try {
    const res = response();
    await updateAgencySearchPeriod({
      user: { _id: 'user-id' },
      body: { year: 2026, month: 13 },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.equal(updated, false);
  } finally {
    GlobalSetting.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
