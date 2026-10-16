'use strict';

const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyHistory = require('../src/models/AgencyHistory');
const {
  createAgency,
  updateAgency,
} = require('../src/controllers/agencyController');
const { removeUniqueAgencyEmailIndex } = require('../src/config/db');

const originalAgencyHistoryCreate = AgencyHistory.create;
beforeEach(() => { AgencyHistory.create = async (entry) => entry; });
afterEach(() => { AgencyHistory.create = originalAgencyHistoryCreate; });

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const agencyPayload = (nombre) => ({
  nombre,
  correo: 'compartido@example.com',
  entidadFederativa: 'Jalisco',
});

test('allows creating agencies with distinct names and the same email', async () => {
  const originalCreate = Agency.create;
  const created = [];
  Agency.create = async (agency) => {
    const saved = { ...agency, _id: new mongoose.Types.ObjectId() };
    created.push(saved);
    return saved;
  };

  try {
    const firstResponse = response();
    await createAgency({
      user: { _id: new mongoose.Types.ObjectId() },
      body: agencyPayload('Marca Centro'),
    }, firstResponse, (error) => { throw error; });
    const secondResponse = response();
    await createAgency({
      user: { _id: new mongoose.Types.ObjectId() },
      body: agencyPayload('Marca Norte'),
    }, secondResponse, (error) => { throw error; });

    assert.equal(firstResponse.statusCode, 201);
    assert.equal(secondResponse.statusCode, 201);
    assert.equal(created.length, 2);
    assert.deepEqual(created.map(({ correo }) => correo), [
      'compartido@example.com',
      'compartido@example.com',
    ]);
  } finally {
    Agency.create = originalCreate;
  }
});

test('allows changing an agency email to an email already used by another agency', async () => {
  const originalFindById = Agency.findById;
  const agency = {
    _id: new mongoose.Types.ObjectId(),
    nombre: 'Marca Norte',
    correo: 'anterior@example.com',
    set(field, value) { this[field] = value; },
    save: async function save() {},
  };
  Agency.findById = async () => agency;

  try {
    const res = response();
    await updateAgency({
      method: 'PUT',
      params: { id: String(agency._id) },
      user: { _id: new mongoose.Types.ObjectId() },
      body: agencyPayload('Marca Norte'),
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.correo, 'compartido@example.com');
  } finally {
    Agency.findById = originalFindById;
  }
});

test('removes an existing single-field unique agency correo index on startup', async () => {
  const originalIndexes = Agency.collection.indexes;
  const originalDropIndex = Agency.collection.dropIndex;
  const removed = [];
  Agency.collection.indexes = async () => [
    { name: '_id_', key: { _id: 1 }, unique: true },
    { name: 'correo_1', key: { correo: 1 }, unique: true },
    { name: 'nombre_correo_unique', key: { nombre: 1, correo: 1 }, unique: true },
    { name: 'correo_search', key: { correo: 1 } },
  ];
  Agency.collection.dropIndex = async (name) => removed.push(name);

  try {
    await removeUniqueAgencyEmailIndex();
    assert.deepEqual(removed, ['correo_1']);
  } finally {
    Agency.collection.indexes = originalIndexes;
    Agency.collection.dropIndex = originalDropIndex;
  }
});
