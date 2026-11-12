'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const mongoose = require('mongoose');
const RevReport = require('../src/formatosGeneradores/rev/models/RevReport');
const { canSavePeriod } = require('../src/utils/reportPeriodAccess');

function makeReport(extinguisher) {
  const userId = new mongoose.Types.ObjectId();
  return new RevReport({
    reportId: `REV-${crypto.randomUUID()}`,
    idempotencyKey: crypto.randomUUID(),
    agencyId: new mongoose.Types.ObjectId(),
    agencyNameSnapshot: 'Sucursal de prueba',
    generalData: { inspectionDate: '2026-11-05', responsible: 'Responsable' },
    extinguishers: Array.isArray(extinguisher) ? extinguisher : [extinguisher],
    createdBy: userId,
    updatedBy: userId,
  });
}

test('REV stores an exclusive type, numeric capacity and configured inspection choices', async () => {
  const report = makeReport({
    n: 1,
    pqs: '1',
    capacidad: 4.5,
    pintura: '2',
    manometro: 'NA',
    status: 'En buen estado',
    ubicacion: 'Show room',
  });

  await report.validate();
  assert.equal(report.extinguishers[0].capacidad, 4.5);
  assert.equal(report.extinguishers[0].ubicacion, 'Show room');
  assert.equal(report.extinguishers[0].observaciones, 'Sin Observaciones');

  report.extinguishers[0].status = 'Próximo a vencer';
  await report.validate();
  report.extinguishers[0].status = 'Vencido';
  await report.validate();
});

test('REV rejects multiple extinguisher types and accepts free-text locations', async () => {
  const multipleTypes = makeReport({ n: 1, pqs: '1', co2: '1' });
  await assert.rejects(multipleTypes.validate(), /Solo se puede seleccionar un tipo de extintor/);

  const freeTextLocation = makeReport({ n: 1, ubicacion: 'Pasillo norte, junto al acceso' });
  await freeTextLocation.validate();
  assert.equal(freeTextLocation.extinguishers[0].ubicacion, 'Pasillo norte, junto al acceso');
});

test('REV limits each report to 80 extinguishers', async () => {
  const report = makeReport(Array.from({ length: 81 }, (_, index) => ({ n: index + 1 })));
  await assert.rejects(report.validate(), /máximo de 80 extintores/);
});

test('only admin and developer can save REV reports for previous periods', () => {
  assert.equal(canSavePeriod({ rol: 'admin' }, '2026-10-01', '2026-11'), true);
  assert.equal(canSavePeriod({ rol: 'developer' }, '2026-10-01', '2026-11'), true);
  assert.equal(canSavePeriod({ rol: 'consultor' }, '2026-10-01', '2026-11'), false);
  assert.equal(canSavePeriod({ rol: 'consultor' }, '2026-11-01', '2026-11'), true);
});
