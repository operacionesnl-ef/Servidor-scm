'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Agency = require('../src/models/Agency');
const { validateAgencyInput } = require('../src/controllers/agencyController');

test('validates and trims agency expediente contact fields', () => {
  const { errors, value } = validateAgencyInput({
    nombre: 'Agencia Centro',
    entidadFederativa: 'Jalisco',
    gerente: '  María López  ',
    telefonoGerente: ' 5550102030 ',
    seguimiento: '  Seguimiento vigente  ',
  }, false);

  assert.deepEqual(errors, {});
  assert.equal(value.gerente, 'María López');
  assert.equal(value.telefonoGerente, '5550102030');
  assert.equal(value.seguimiento, 'Seguimiento vigente');

  const agency = new Agency({
    nombre: value.nombre,
    entidadFederativa: value.entidadFederativa,
    ...value,
  });
  assert.equal(agency.validateSync(), undefined);
});

test('rejects invalid or overlong agency expediente contact fields', () => {
  const { errors } = validateAgencyInput({
    nombre: 'Agencia Centro',
    entidadFederativa: 'Jalisco',
    gerente: 42,
    telefonoGerente: 'x'.repeat(41),
    seguimiento: 'x'.repeat(4001),
  }, false);

  assert.equal(errors.gerente, 'Must be a string');
  assert.equal(errors.telefonoGerente, 'Must not exceed 40 characters');
  assert.equal(errors.seguimiento, 'Must not exceed 4000 characters');
});
