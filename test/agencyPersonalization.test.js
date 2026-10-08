'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyTag = require('../src/models/AgencyTag');
const AgencyPersonalization = require('../src/models/AgencyPersonalization');
const { validateTagInput } = require('../src/controllers/agencyPersonalizationController');
const {
  migrateLegacyPersonalizations,
  updateAgencyPersonalization,
} = require('../src/controllers/agencyPersonalizationController');
const { AGENCY_TAG_COLORS } = require('../src/models/AgencyTag');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('accepts agency tags with valid roles and one of the eight supported colors', () => {
  const result = validateTagInput({
    name: 'Prioridad',
    color: AGENCY_TAG_COLORS[0],
    allowedRoles: ['admin', 'user', 'user'],
  });

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.value, {
    name: 'Prioridad',
    nameKey: 'prioridad',
    color: AGENCY_TAG_COLORS[0],
    allowedRoles: ['admin', 'user'],
  });
});

test('rejects empty role lists, unknown roles, and colors outside the palette', () => {
  const result = validateTagInput({
    name: 'Sin color válido',
    color: '#000000',
    allowedRoles: ['guest'],
  });

  assert.deepEqual(Object.keys(result.errors).sort(), ['allowedRoles', 'color']);
});

test('allows a partial tag update but rejects unknown fields', () => {
  const result = validateTagInput({ color: AGENCY_TAG_COLORS[1], extra: true }, true);

  assert.deepEqual(result.errors, { extra: 'Unknown field' });
  assert.deepEqual(result.value, { color: AGENCY_TAG_COLORS[1] });
});

test('refuses to assign a tag that is not permitted for the current user role', async () => {
  const originalFindAgencies = Agency.find;
  const originalFindById = Agency.findById;
  const originalFind = AgencyTag.find;
  const originalFindOne = AgencyPersonalization.findOne;
  let preferenceWasChanged = false;
  const tagId = new mongoose.Types.ObjectId().toString();
  Agency.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  Agency.findById = () => ({
    select() {
      return Promise.resolve({
        _id: new mongoose.Types.ObjectId(),
        tags: [],
        save: async () => {},
      });
    },
  });
  AgencyTag.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  AgencyPersonalization.findOne = () => { preferenceWasChanged = true; };

  try {
    const res = response();
    await updateAgencyPersonalization({
      params: { id: new mongoose.Types.ObjectId().toString() },
      user: { _id: new mongoose.Types.ObjectId(), rol: 'user' },
      body: { favorite: true, tagIds: [tagId] },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.equal(preferenceWasChanged, false);
  } finally {
    Agency.find = originalFindAgencies;
    Agency.findById = originalFindById;
    AgencyTag.find = originalFind;
    AgencyPersonalization.findOne = originalFindOne;
  }
});

test('stores favorite changes directly on the shared agency record', async () => {
  const originalMethods = {
    find: Agency.find,
    findById: Agency.findById,
    updateOne: Agency.updateOne,
    findPreferences: AgencyPersonalization.find,
  };
  const agencyId = new mongoose.Types.ObjectId();
  const agency = {
    _id: agencyId,
    favorite: false,
    tags: [],
    save: async function save() {},
  };
  let savedAgency;
  agency.save = async function save() {
    savedAgency = this;
  };
  Agency.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  AgencyPersonalization.find = () => ({ select: async () => [] });
  Agency.updateOne = async () => {};
  Agency.findById = () => ({
    select: async () => agency,
  });

  try {
    const res = response();
    await updateAgencyPersonalization({
      params: { id: String(agencyId) },
      user: { _id: new mongoose.Types.ObjectId(), rol: 'user' },
      body: { favorite: true },
    }, res, (error) => { throw error; });

    assert.equal(savedAgency.favorite, true);
    assert.equal(savedAgency.personalizationMigrated, true);
    assert.deepEqual(res.body.data, {
      agencyId: String(agencyId),
      favorite: true,
      tagIds: [],
    });
  } finally {
    Agency.find = originalMethods.find;
    Agency.findById = originalMethods.findById;
    Agency.updateOne = originalMethods.updateOne;
    AgencyPersonalization.find = originalMethods.findPreferences;
  }
});

test('merges legacy user preferences into one shared agency preference exactly once', async () => {
  const originalMethods = {
    find: Agency.find,
    updateOne: Agency.updateOne,
    findPreferences: AgencyPersonalization.find,
  };
  const agencyId = new mongoose.Types.ObjectId();
  const tagOne = new mongoose.Types.ObjectId();
  const tagTwo = new mongoose.Types.ObjectId();
  const updates = [];
  Agency.find = () => ({
    select() { return this; },
    lean: async () => [{ _id: agencyId, favorite: false, tags: [] }],
  });
  AgencyPersonalization.find = () => ({
    select() {
      return {
        lean: async () => [
          { agencyId, favorite: true, tags: [tagOne] },
          { agencyId, favorite: false, tags: [tagTwo] },
          { agencyId, favorite: false },
        ],
      };
    },
  });
  Agency.updateOne = async (...args) => { updates.push(args); };

  try {
    await migrateLegacyPersonalizations();
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0][1].$set, {
      favorite: true,
      tags: expectMongoIds([tagOne, tagTwo]),
      personalizationMigrated: true,
    });
  } finally {
    Agency.find = originalMethods.find;
    Agency.updateOne = originalMethods.updateOne;
    AgencyPersonalization.find = originalMethods.findPreferences;
  }
});

function expectMongoIds(values) {
  return values.map(String);
}
