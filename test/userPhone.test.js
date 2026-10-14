const assert = require('node:assert/strict');
const { test } = require('node:test');
const User = require('../src/models/User');
const { createUser, updateUser } = require('../src/controllers/userController');

const createResponse = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('phone is optional and uses a sparse unique index', () => {
  const phonePath = User.schema.path('telefono');
  assert.equal(phonePath.isRequired, false);
  assert.equal(phonePath.options.unique, true);
  assert.equal(phonePath.options.sparse, true);
});

test('user creation accepts a formatted phone and returns it', async () => {
  const originalCreate = User.create;
  let created;
  User.create = async (value) => {
    created = value;
    return {
      ...value,
      _id: 'user-1',
      autenticacion: { proveedor: 'local' },
    };
  };

  try {
    const response = createResponse();
    await createUser({
      body: {
        nombre: ' Ana ',
        correo: ' ANA@example.com ',
        telefono: ' +1 (212) 555-0100 ',
      },
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 201);
    assert.equal(created.nombre, 'Ana');
    assert.equal(created.correo, 'ana@example.com');
    assert.equal(created.telefono, '+1 (212) 555-0100');
    assert.equal(response.body.data.telefono, '+1 (212) 555-0100');
  } finally {
    User.create = originalCreate;
  }
});

test('user creation does not require a phone number', async () => {
  const originalCreate = User.create;
  let created;
  User.create = async (value) => {
    created = value;
    return { ...value, _id: 'user-2', autenticacion: { proveedor: 'local' } };
  };

  try {
    const response = createResponse();
    await createUser({
      body: { nombre: 'Ana', correo: 'ana@example.com', telefono: '' },
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 201);
    assert.equal(Object.hasOwn(created, 'telefono'), false);
  } finally {
    User.create = originalCreate;
  }
});

test('user creation rejects malformed phone numbers', async () => {
  const originalCreate = User.create;
  User.create = async () => {
    assert.fail('invalid phone must not reach persistence');
  };

  try {
    const response = createResponse();
    await createUser({
      body: {
        nombre: 'Ana',
        correo: 'ana@example.com',
        telefono: 'not-a-phone',
      },
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 400);
    assert.ok(response.body.errors.telefono);
  } finally {
    User.create = originalCreate;
  }
});

test('user updates persist and return the phone number', async () => {
  const originalFindById = User.findById;
  const userId = '507f1f77bcf86cd799439011';
  const user = {
    _id: userId,
    nombre: 'Ana',
    correo: 'ana@example.com',
    rol: 'consultor',
    status: 'activo',
    autenticacion: { proveedor: 'local' },
    async save() {},
  };
  User.findById = async () => user;

  try {
    const response = createResponse();
    await updateUser({
      params: { id: userId },
      body: { telefono: '212-555-0100' },
      user: { _id: '507f1f77bcf86cd799439012' },
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 200);
    assert.equal(user.telefono, '212-555-0100');
    assert.equal(response.body.data.telefono, '212-555-0100');
  } finally {
    User.findById = originalFindById;
  }
});

test('user updates can clear an existing phone number', async () => {
  const originalFindById = User.findById;
  const userId = '507f1f77bcf86cd799439011';
  const user = {
    _id: userId,
    nombre: 'Ana',
    correo: 'ana@example.com',
    telefono: '212-555-0100',
    rol: 'consultor',
    status: 'activo',
    autenticacion: { proveedor: 'local' },
    async save() {},
  };
  User.findById = async () => user;

  try {
    const response = createResponse();
    await updateUser({
      params: { id: userId },
      body: { telefono: '' },
      user: { _id: '507f1f77bcf86cd799439012' },
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 200);
    assert.equal(user.telefono, undefined);
  } finally {
    User.findById = originalFindById;
  }
});

test('duplicate phone numbers return a phone-specific conflict', async () => {
  const originalCreate = User.create;
  User.create = async () => {
    const error = new Error('duplicate phone');
    error.code = 11000;
    error.keyPattern = { telefono: 1 };
    throw error;
  };

  try {
    const response = createResponse();
    await createUser({
      body: {
        nombre: 'Ana',
        correo: 'ana@example.com',
        telefono: '+1 212 555 0100',
      },
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /phone number/);
  } finally {
    User.create = originalCreate;
  }
});
