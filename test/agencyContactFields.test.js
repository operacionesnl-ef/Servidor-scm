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

test('validates and trims agency company name and address', () => {
  const { errors, value } = validateAgencyInput({
    nombre: 'Agencia Centro',
    entidadFederativa: 'Jalisco',
    razonSocial: '  Empresa Centro  ',
    direccion: '  Av. Central 123  ',
  }, false);

  assert.deepEqual(errors, {});
  assert.equal(value.razonSocial, 'Empresa Centro');
  assert.equal(value.direccion, 'Av. Central 123');
});

test('rejects non-string agency company name and address', () => {
  const { errors } = validateAgencyInput({
    nombre: 'Agencia Centro',
    entidadFederativa: 'Jalisco',
    razonSocial: 42,
    direccion: null,
  }, false);

  assert.equal(errors.razonSocial, 'Must be a string');
  assert.equal(errors.direccion, 'Must be a string');
});

test('accepts optional agency coordinates and validates their geographic ranges', () => {
  const { errors, value } = validateAgencyInput({
    nombre: 'Agencia Centro',
    entidadFederativa: 'Jalisco',
    longitud: -103.3496,
    latitud: 20.6597,
  }, false);

  assert.deepEqual(errors, {});
  assert.equal(value.longitud, -103.3496);
  assert.equal(value.latitud, 20.6597);

  const agency = new Agency({
    nombre: value.nombre,
    entidadFederativa: value.entidadFederativa,
    ...value,
  });
  assert.equal(agency.validateSync(), undefined);

  const agencyWithoutCoordinates = new Agency({
    nombre: 'Agencia Norte',
    entidadFederativa: 'Chihuahua',
  });
  assert.equal(agencyWithoutCoordinates.validateSync(), undefined);
});

test('rejects agency coordinates outside geographic ranges or non-numeric values', () => {
  const { errors } = validateAgencyInput({
    nombre: 'Agencia Centro',
    entidadFederativa: 'Jalisco',
    longitud: 181,
    latitud: '20.6597',
  }, false);

  assert.equal(errors.longitud, 'Must be between -180 and 180');
  assert.equal(errors.latitud, 'Must be a number or null');
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
