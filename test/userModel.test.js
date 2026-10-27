const assert = require('node:assert/strict');
const { test } = require('node:test');
const User = require('../src/models/User');

test('user role defaults to user and only accepts supported roles', () => {
  const user = new User({ nombre: 'Test', correo: 'test@example.com' });
  assert.equal(user.rol, 'user');

  const rolePath = User.schema.path('rol');
  assert.deepEqual(rolePath.enumValues, ['developer', 'admin', 'user', 'consultor', 'organizador']);
  assert.equal(new User({
    nombre: 'Organizador',
    correo: 'organizador@example.com',
    rol: 'organizador',
  }).validateSync(), undefined);
  assert.equal(new User({ rol: 'owner' }).validateSync().errors.rol.kind, 'enum');
});