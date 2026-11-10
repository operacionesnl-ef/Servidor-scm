'use strict';

const TYPE_FIELDS = ['pqs', 'co2', 'agua', 'tipod', 'tipok'];
const CHECK_FIELDS = [
  'pintura', 'golpes', 'adhesivo', 'transporte', 'disparo', 'presion',
  'manometro', 'manguera', 'ring', 'boquilla', 'senalizacion', 'libre', 'limpio',
];
const CHECK_VALUES = ['', '1', '0', 'NA', 'NT', '2', 'NR'];
const STATUS_OPTIONS = ['', 'En buen estado', 'Próximo a vencer', 'Vencido'];
module.exports = {
  CHECK_FIELDS,
  CHECK_VALUES,
  STATUS_OPTIONS,
  TYPE_FIELDS,
};
