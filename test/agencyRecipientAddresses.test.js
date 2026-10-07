'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateAgencyInput } = require('../src/controllers/agencyController');

const baseAgency = {
  nombre: 'Agencia Centro',
  correo: 'centro@example.com',
  entidadFederativa: 'Jalisco',
};

test('validates and normalizes per-agency CC and CCO fields', () => {
  const { errors, value } = validateAgencyInput({
    ...baseAgency,
    cc: [' CC@example.com ', 'cc2@example.com'],
    cco: ['hidden@example.com'],
  }, false);

  assert.deepEqual(errors, {});
  assert.deepEqual(value.cc, ['cc@example.com', 'cc2@example.com']);
  assert.deepEqual(value.cco, ['hidden@example.com']);
});

test('leaves omitted CC and CCO unchanged during agency updates', () => {
  const { errors, value } = validateAgencyInput(baseAgency, false);

  assert.deepEqual(errors, {});
  assert.equal(Object.hasOwn(value, 'cc'), false);
  assert.equal(Object.hasOwn(value, 'cco'), false);
});

test('rejects invalid per-agency recipient addresses', () => {
  const { errors } = validateAgencyInput({
    ...baseAgency,
    cc: ['not-an-address'],
  }, false);

  assert.equal(errors['cc.0'], 'Must be a valid email address');
});
