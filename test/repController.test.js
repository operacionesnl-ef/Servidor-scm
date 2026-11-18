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
        ciudad: 'Monterrey',
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
        startAt: new Date('2099-10-29T14:00:00.000Z'),
        endAt: new Date('2099-10-29T16:00:00.000Z'),
      }),
    }),
  });
  AgencyMonthlyFiles.findOne = () => {
    const query = { lean: async () => null };
    query.select = () => query;
    return query;
  };
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
      findings: [{
        area: 'Patio',
        element: 'Extintor',
        legalBasis: 'NOM aplicable',
        correctiveAction: 'Reparar',
        preventiveAction: 'Inspeccionar',
      }],
      documents: {},
    },
  }, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 201);
  assert.equal(created.agencyLegalNameSnapshot, 'Empresa Norte');
  assert.equal(created.agencyCitySnapshot, 'Monterrey');
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

test('returns every ANX photo associated with a REP finding', async () => {
  const images = Array.from({ length: 4 }, (_, index) => ({
    imageId: `photo-id-12345${index}`,
    numero: index + 1,
    registroId: 'finding-123456',
    fileName: `photo-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
  }));
  ANX.findOne = () => ({ lean: async () => ({ imagenes: images }) });
  const response = {
    json(body) { this.body = body; return this; },
  };
  let nextError;

  await controller.getRepReport({
    repReport: {
      reportId: 'REP-123',
      findings: [{ findingId: 'finding-123456', imageNumber: '' }],
    },
  }, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.body.data.report.findings[0].images.length, 4);
  assert.deepEqual(
    response.body.data.report.findings[0].images.map((image) => image.imageId),
    images.map((image) => image.imageId),
  );
  assert.equal(response.body.data.report.findings[0].imageNumber, 1);
});

test('rejects a fifth photo for a finding', async () => {
  ANX.findOne = async () => ({
    imagenes: Array.from({ length: 4 }, (_, index) => ({
      imageId: `photo-id-12345${index}`,
      registroId: 'finding-123456',
    })),
  });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError;

  await controller.uploadRepFindingImage({
    user: { rol: 'admin' },
    repReport: {
      reportId: 'REP-123',
      findings: [{ findingId: 'finding-123456' }],
    },
    params: { findingId: 'finding-123456', imageId: 'photo-id-123459' },
    file: { buffer: Buffer.from('image') },
  }, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 409);
  assert.match(response.body.message, /hasta 4 fotografías/);
});

test('allows a consultant to upload photos to their own draft REP', async () => {
  const userId = new mongoose.Types.ObjectId();
  ANX.findOne = async () => ({
    imagenes: Array.from({ length: 4 }, (_, index) => ({
      imageId: `photo-id-12345${index}`,
      registroId: 'finding-123456',
    })),
  });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError;

  await controller.uploadRepFindingImage({
    user: { _id: userId, rol: 'consultor' },
    repReport: {
      reportId: 'REP-123',
      status: 'draft',
      createdBy: userId,
      findings: [{ findingId: 'finding-123456' }],
    },
    params: { findingId: 'finding-123456', imageId: 'photo-id-123456' },
    file: { buffer: Buffer.from('image') },
  }, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 409);
  assert.match(response.body.message, /hasta 4 fotografías/);
});
