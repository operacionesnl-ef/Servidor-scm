'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { afterEach, test } = require('node:test');
const Agency = require('../src/models/Agency');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const ForReport = require('../src/formatosGeneradores/for/models/ForReport');
const controller = require('../src/formatosGeneradores/for/controllers/forReportController');

const originalAgencyFindOne = Agency.findOne;
const originalReportFindOne = ForReport.findOne;
const originalReportFindOneAndUpdate = ForReport.findOneAndUpdate;
const originalReportSave = ForReport.prototype.save;
const originalMonthlyFindOne = AgencyMonthlyFiles.findOne;
const originalMonthlyFindOneAndUpdate = AgencyMonthlyFiles.findOneAndUpdate;

afterEach(() => {
  Agency.findOne = originalAgencyFindOne;
  ForReport.findOne = originalReportFindOne;
  ForReport.findOneAndUpdate = originalReportFindOneAndUpdate;
  ForReport.prototype.save = originalReportSave;
  AgencyMonthlyFiles.findOne = originalMonthlyFindOne;
  AgencyMonthlyFiles.findOneAndUpdate = originalMonthlyFindOneAndUpdate;
});

test('allows reportRevision zero while Excel generation has not been requested', () => {
  const revisionPath = ForReport.schema.path('generatedExcel.reportRevision');
  assert.equal(revisionPath.options.min, 0);
  assert.equal(revisionPath.options.default, 0);
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

test('persists the visit number submitted for a new report', async () => {
  const agencyId = '507f1f77bcf86cd799439012';
  const userId = '507f1f77bcf86cd799439011';
  const idempotencyKey = 'request-key-0001';
  let savedReport;
  ForReport.findOne = (filter) => ({
    select: (fields) => (filter.idempotencyKey
      ? Promise.resolve(null)
      : { lean: async () => null }),
  });
  ForReport.prototype.save = async function save() {
    savedReport = this;
    return this;
  };
  Agency.findOne = () => ({
    select: () => ({
      lean: async () => ({
        _id: agencyId,
        nombre: 'Agencia Norte',
        razonSocial: 'Empresa Norte',
        marca: 'Marca',
        fileNameCode: 'AG-NOR',
      }),
    }),
  });
  AgencyMonthlyFiles.findOne = () => ({
    select: () => ({ lean: async () => null }),
  });
  AgencyMonthlyFiles.findOneAndUpdate = async () => ({});

  const res = makeResponse();
  await controller.saveReportContent({
    body: {
      agencyId,
      agencyPeriod: '2026-10',
      generalData: {
        inspectionDate: '2026-10-23',
        observations: '',
        visitNumber: 2,
      },
      environmentalAspects: [],
      evidence: [],
    },
    get: (name) => (name === 'Idempotency-Key' ? idempotencyKey : undefined),
    user: { _id: userId, rol: 'admin' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(savedReport.generalData.visitNumber, 2);
  assert.equal(res.body.data.report.generalData.visitNumber, 2);
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

test('requeues a ready report when its generated Excel file is missing', async () => {
  const reportId = `FOR-${crypto.randomUUID()}`;
  const report = {
    _id: '507f1f77bcf86cd799439099',
    reportId,
    agencyId: '507f1f77bcf86cd799439012',
    agencyPeriod: '2026-10',
    agencyNameSnapshot: 'Agencia Norte',
    agencyFileNameCodeSnapshot: 'HYN-SAN-NL',
    revision: 6,
    createdBy: '507f1f77bcf86cd799439011',
    updatedBy: '507f1f77bcf86cd799439011',
    generalData: { inspectionDate: '2026-10-01' },
    generatedExcel: {
      status: 'ready',
      reportRevision: 6,
      templateVersion: '1.1',
      storageProvider: 'local',
      localFileName: `${reportId}-rev-6.xlsx`,
    },
    save: async () => {},
  };
  const monthlyUpdates = [];
  AgencyMonthlyFiles.findOneAndUpdate = async (...args) => {
    monthlyUpdates.push(args);
    return {};
  };
  ForReport.findOneAndUpdate = async () => null;
  const res = makeResponse();

  await controller.queueForReportExcel({
    body: { expectedRevision: 6 },
    forReport: report,
    user: { _id: report.createdBy, rol: 'admin' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 202);
  assert.equal(report.generatedExcel.status, 'queued');
  assert.equal(report.generatedExcel.storageProvider, 'drive');
  assert.equal(report.generatedExcel.localFileName, '');
  assert.equal(monthlyUpdates.length, 1);
  assert.equal(monthlyUpdates[0][1].$set['archivos.archivo2'].generatedExcelStatus, 'queued');
});

test('requeues a ready report generated with an older template version', async () => {
  const reportId = `FOR-${crypto.randomUUID()}`;
  const report = {
    _id: '507f1f77bcf86cd799439098',
    reportId,
    agencyId: '507f1f77bcf86cd799439012',
    agencyPeriod: '2026-10',
    agencyNameSnapshot: 'Agencia Norte',
    agencyFileNameCodeSnapshot: 'HYN-SAN-NL',
    revision: 6,
    createdBy: '507f1f77bcf86cd799439011',
    updatedBy: '507f1f77bcf86cd799439011',
    generalData: { inspectionDate: '2026-10-01' },
    generatedExcel: {
      status: 'ready',
      reportRevision: 6,
      templateVersion: '1.0',
      storageProvider: 'drive',
      driveFileId: 'old-drive-file',
    },
    save: async () => {},
  };
  const monthlyUpdates = [];
  AgencyMonthlyFiles.findOneAndUpdate = async (...args) => {
    monthlyUpdates.push(args);
    return {};
  };
  ForReport.findOneAndUpdate = async () => null;
  const res = makeResponse();

  await controller.queueForReportExcel({
    body: { expectedRevision: 6 },
    forReport: report,
    user: { _id: report.createdBy, rol: 'admin' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 202);
  assert.equal(report.generatedExcel.status, 'queued');
  assert.equal(report.generatedExcel.templateVersion, '1.1');
  assert.equal(monthlyUpdates[0][1].$set['archivos.archivo2'].generatedExcelStatus, 'queued');
});
test('requeues a ready report created with an older generator version', async () => {
  const reportId = `FOR-${crypto.randomUUID()}`;
  const report = {
    _id: '507f1f77bcf86cd799439098',
    reportId,
    agencyId: '507f1f77bcf86cd799439012',
    agencyPeriod: '2026-10',
    agencyNameSnapshot: 'Agencia Norte',
    agencyFileNameCodeSnapshot: 'HYN-SAN-NL',
    revision: 6,
    createdBy: '507f1f77bcf86cd799439011',
    updatedBy: '507f1f77bcf86cd799439011',
    generalData: { inspectionDate: '2026-10-01' },
    generatedExcel: {
      status: 'ready',
      reportRevision: 6,
      templateVersion: '1.0',
      storageProvider: 'drive',
      driveFileId: 'old-drive-file',
    },
    save: async () => {},
  };
  const monthlyUpdates = [];
  AgencyMonthlyFiles.findOneAndUpdate = async (...args) => {
    monthlyUpdates.push(args);
    return {};
  };
  ForReport.findOneAndUpdate = async () => null;
  const res = makeResponse();

  await controller.queueForReportExcel({
    body: { expectedRevision: 6 },
    forReport: report,
    user: { _id: report.createdBy, rol: 'admin' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 202);
  assert.equal(report.generatedExcel.status, 'queued');
  assert.equal(report.generatedExcel.templateVersion, '1.1');
  assert.equal(monthlyUpdates[0][1].$set['archivos.archivo2'].generatedExcelStatus, 'queued');
});
