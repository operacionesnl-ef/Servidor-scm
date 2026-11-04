'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const CalendarEvent = require('../src/models/CalendarEvent');
const RepReport = require('../src/formatosGeneradores/rep/models/RepReport');
const ANX = require('../src/formatosGeneradores/rep/models/ANX');
const controller = require('../src/formatosGeneradores/rep/controllers/repController');

const originalAgencyFindOne = Agency.findOne;
const originalCalendarEventFindOne = CalendarEvent.findOne;
const originalMonthlyFindOne = AgencyMonthlyFiles.findOne;
const originalMonthlyFindOneAndUpdate = AgencyMonthlyFiles.findOneAndUpdate;
const originalReportFindOne = RepReport.findOne;
const originalReportCreate = RepReport.create;
const originalAnxFindOne = ANX.findOne;

afterEach(() => {
  Agency.findOne = originalAgencyFindOne;
  CalendarEvent.findOne = originalCalendarEventFindOne;
  AgencyMonthlyFiles.findOne = originalMonthlyFindOne;
  AgencyMonthlyFiles.findOneAndUpdate = originalMonthlyFindOneAndUpdate;
  RepReport.findOne = originalReportFindOne;
  RepReport.create = originalReportCreate;
  ANX.findOne = originalAnxFindOne;
});

test('creates a REP snapshot for an assigned consultant and persists the defined payload', async () => {
  const agencyId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const calendarEventId = new mongoose.Types.ObjectId();
  let created;
  Agency.findOne = () => ({
    select: () => ({
      lean: async () => ({
        _id: agencyId,
        nombre: 'Sucursal Norte',
        razonSocial: 'Empresa Norte',
        direccion: 'Calle Uno',
        entidadFederativa: 'Nuevo León',
        brand: 'MARCA-DIRECTA',
        marca: 'MARCA',
        fileNameCode: 'HYU-SEN-NL',
      }),
    }),
  });
  RepReport.findOne = async () => null;
  ANX.findOne = () => ({ lean: async () => null });
  CalendarEvent.findOne = () => ({
    select: () => ({
      lean: async () => ({
        _id: calendarEventId,
        startAt: new Date('2026-10-29T14:00:00.000Z'),
        endAt: new Date('2026-10-29T16:00:00.000Z'),
      }),
    }),
  });
  AgencyMonthlyFiles.findOne = () => ({ lean: async () => null });
  AgencyMonthlyFiles.findOneAndUpdate = async () => ({});
  RepReport.create = async (value) => {
    created = value;
    return { ...value, toObject: () => ({ ...value }) };
  };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError;
  await controller.createRepReport({
    user: { _id: userId, rol: 'consultor' },
    body: {
      agencyId: String(agencyId),
      calendarEventId: String(calendarEventId),
      idempotencyKey: 'request-123456',
      generalData: {
        inspectionDate: '2026-10-29',
        startDate: '2026-10-29',
        endDate: '2026-10-29',
        visitType: 'ordinario',
      },
      findings: [{ area: 'Patio', element: 'Extintor', correctiveAction: 'Reparar', preventiveAction: 'Inspeccionar' }],
      documents: {},
    },
  }, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 201);
  assert.equal(created.agencyLegalNameSnapshot, 'Empresa Norte');
  assert.equal(created.agencyBrandSnapshot, 'MARCA-DIRECTA');
  assert.equal(created.agencyFileNameCodeSnapshot, 'HYU-SEN-NL');
  assert.equal(created.calendarEventId, calendarEventId);
  assert.equal(created.generalData.startTime, '08:00');
  assert.equal(created.generalData.endTime, '10:00');
  assert.equal(created.findings[0].preventiveAction, 'Inspeccionar');
  assert.equal(response.body.data.report.idempotencyKey, undefined);
});

test('returns a validation error before accessing agency records for invalid REP data', async () => {
  let agencyLookups = 0;
  Agency.findOne = () => { agencyLookups += 1; throw new Error('Should not query agency'); };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await controller.createRepReport({
    user: { _id: new mongoose.Types.ObjectId(), rol: 'consultor' },
    body: { generalData: {}, findings: [], documents: {} },
  }, response, (error) => { throw error; });

  assert.equal(response.statusCode, 400);
  assert.equal(agencyLookups, 0);
});
