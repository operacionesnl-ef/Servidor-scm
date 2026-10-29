'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const Agency = require('../src/models/Agency');
const ForReport = require('../src/models/ForReport');
const controller = require('../src/controllers/forReportController');

const originalAgencyFindOne = Agency.findOne;
const originalReportFindOne = ForReport.findOne;

afterEach(() => {
  Agency.findOne = originalAgencyFindOne;
  ForReport.findOne = originalReportFindOne;
});

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('allows a consultant to load a report for an assigned agency', async () => {
  const userId = '507f1f77bcf86cd799439011';
  const agencyId = '507f1f77bcf86cd799439012';
  const report = { reportId: 'FOR-12345678-1234-1234-1234-123456789012', agencyId };
  let agencyFilter;
  ForReport.findOne = async () => report;
  Agency.findOne = (filter) => {
    agencyFilter = filter;
    return { select: () => ({ lean: async () => ({ _id: agencyId, nombre: 'Agencia Norte' }) }) };
  };

  const req = { user: { _id: userId, rol: 'consultor' } };
  const res = makeResponse();
  let nextCalled = false;
  await controller.loadReport(
    req,
    res,
    () => { nextCalled = true; },
    report.reportId,
  );

  assert.equal(nextCalled, true);
  assert.equal(req.forReport, report);
  assert.deepEqual(agencyFilter, { _id: agencyId, consultantId: userId });
});

test('does not load a report when the consultant is not assigned to its agency', async () => {
  const userId = '507f1f77bcf86cd799439011';
  const agencyId = '507f1f77bcf86cd799439012';
  const report = { reportId: 'FOR-12345678-1234-1234-1234-123456789012', agencyId };
  ForReport.findOne = async () => report;
  Agency.findOne = () => ({ select: () => ({ lean: async () => null }) });

  const res = makeResponse();
  let nextCalled = false;
  await controller.loadReport(
    { user: { _id: userId, rol: 'consultor' } },
    res,
    () => { nextCalled = true; },
    report.reportId,
  );

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.message, /no tienes acceso asignado/i);
});

test('does not allow a regular user role to update a report', async () => {
  const res = makeResponse();
  await controller.updateForReport({
    body: {},
    forReport: { revision: 1 },
    user: { _id: '507f1f77bcf86cd799439011', rol: 'user' },
  }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 403);
});

test('rejects an update with a stale revision without saving', async () => {
  let saveCalled = false;
  const report = {
    revision: 3,
    status: 'draft',
    generalData: { inspectionDate: '2026-10-23', observations: '' },
    environmentalAspects: [],
    evidence: [],
    save: async () => { saveCalled = true; },
  };
  const res = makeResponse();

  await controller.updateForReport({
    body: {
      expectedRevision: 2,
      generalData: { inspectionDate: '2026-10-23', observations: '' },
      environmentalAspects: [],
      evidence: [],
    },
    forReport: report,
    user: { _id: '507f1f77bcf86cd799439011', rol: 'admin' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /cambió desde que lo abriste/i);
  assert.equal(saveCalled, false);
});

test('rejects consultant updates to an existing report', async () => {
  let saveCalled = false;
  const res = makeResponse();
  await controller.updateForReport({
    body: {},
    forReport: { revision: 1, save: async () => { saveCalled = true; } },
    user: { _id: '507f1f77bcf86cd799439011', rol: 'consultor' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 403);
  assert.equal(saveCalled, false);
});
