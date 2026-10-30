'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ASPECTS,
  validateReportCompletion: validateFormatCompletion,
} = require('../src/formats/forAudAmb');
const {
  getDetectedImageMimeType,
  reconcileReportContent,
  validateReportCompletion,
  validateReportPayload,
} = require('../src/services/forReportService');

function makePayload(overrides = {}) {
  return {
    generalData: { inspectionDate: '2026-10-23', observations: '' },
    environmentalAspects: [],
    evidence: [],
    ...overrides,
  };
}

test('accepts a partial draft with a valid inspection date', () => {
  const result = validateReportPayload(makePayload());
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.generalData.inspectionDate, '2026-10-23');
  assert.equal(result.value.agencyPeriod, '2026-10');
});

test('persists explicit non-applicable sections and rejects unknown categories', () => {
  const result = validateReportPayload(makePayload({
    notApplicableCategories: ['taller', 'area-lavado'],
  }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value.notApplicableCategories, ['taller', 'area-lavado']);

  const invalid = validateReportPayload(makePayload({
    notApplicableCategories: ['unknown-section'],
  }));
  assert.ok(invalid.errors.some((error) => error.includes('no aplicables')));
});

test('accepts a monthly system period separate from the inspection date', () => {
  const valid = validateReportPayload(makePayload({
    agencyPeriod: '2026-11',
    generalData: { inspectionDate: '2026-10-22', observations: '' },
  }));
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.value.agencyPeriod, '2026-11');

  const invalid = validateReportPayload(makePayload({ agencyPeriod: '2041-01' }));
  assert.ok(invalid.errors.some((error) => error.includes('período del reporte')));
});

test('validates and preserves the agency legal name and visit number', () => {
  const result = validateReportPayload(makePayload({
    generalData: {
      companyName: 'Sucursal Norte',
      legalName: 'Empresa Norte S.A. de C.V.',
      visitNumber: 9,
      inspectionDate: '2026-10-23',
      observations: '',
    },
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.value.generalData.companyName, 'Sucursal Norte');
  assert.equal(result.value.generalData.legalName, 'Empresa Norte S.A. de C.V.');
  assert.equal(result.value.generalData.visitNumber, 9);

  const invalid = validateReportPayload(makePayload({
    generalData: {
      inspectionDate: '2026-10-23',
      observations: '',
      visitNumber: 0,
    },
  }));
  assert.ok(invalid.errors.some((error) => error.includes('número de visita')));
});

test('rejects invalid dates, duplicate aspects, and unsupported answers', () => {
  const aspect = ASPECTS[0];
  const result = validateReportPayload(makePayload({
    generalData: { inspectionDate: '2026-02-30', observations: '' },
    environmentalAspects: [
      { categoryId: aspect.categoryId, aspectId: aspect.id, answer: 'yes', observation: '' },
      { categoryId: aspect.categoryId, aspectId: aspect.id, answer: '1', observation: '' },
    ],
  }));

  assert.ok(result.errors.some((error) => error.includes('fecha')));
  assert.ok(result.errors.some((error) => error.includes('duplicada')));
  assert.ok(result.errors.some((error) => error.includes('debe ser 1, 0 o NA')));
});

test('validates completion requirements and allows NA without an observation', () => {
  const report = {
    environmentalAspects: ASPECTS.filter(({ required }) => required).map((aspect) => ({
      categoryId: aspect.categoryId,
      aspectId: aspect.id,
      answer: 'NA',
      observation: '',
    })),
    evidence: [{
      status: 'active',
      description: 'Evidencia capturada',
      images: [{ status: 'active', driveFileId: 'drive-file-1' }],
    }],
  };

  assert.deepEqual(validateFormatCompletion(report), {
    complete: true,
    missingAspects: [],
    missingEvidence: false,
  });
  assert.equal(validateReportCompletion(report).complete, true);

  report.evidence[0].images[0].status = 'pending';
  assert.equal(validateReportCompletion(report).complete, false);
  assert.equal(validateReportCompletion(report).pendingImages, 1);
});

test('allows completed required answers with empty observations but still requires answers', () => {
  const report = {
    environmentalAspects: ASPECTS.filter(({ required }) => required).map((aspect) => ({
      categoryId: aspect.categoryId,
      aspectId: aspect.id,
      answer: '1',
      observation: '',
    })),
    evidence: [{
      status: 'active',
      description: 'Evidencia capturada',
      images: [{ status: 'active', driveFileId: 'drive-file-1' }],
    }],
  };

  assert.equal(validateFormatCompletion(report).complete, true);

  report.environmentalAspects[0].answer = null;
  assert.equal(validateFormatCompletion(report).complete, false);
  assert.ok(validateFormatCompletion(report).missingAspects.includes(ASPECTS[0].id));
});

test('reconciles uploaded image references without trusting client Drive IDs', () => {
  const report = {
    generalData: { inspectionDate: '2026-10-23', observations: '' },
    environmentalAspects: [],
    evidence: [],
    agencyNameSnapshot: 'Agencia Norte',
    revision: 1,
    status: 'draft',
  };
  const value = validateReportPayload(makePayload({
    evidence: [{
      evidenceId: 'evidence-001',
      description: 'Foto del área',
      images: [{
        imageId: 'image-0001',
        fileName: 'foto.jpg',
        mimeType: 'image/jpeg',
        driveFileId: 'client-controlled-id',
      }],
    }],
  })).value;

  reconcileReportContent(report, value, 'user-1');

  assert.equal(report.evidence[0].images[0].driveFileId, '');
  assert.equal(report.evidence[0].images[0].status, 'pending');
  assert.equal(report.evidence[0].images[0].fileName, 'foto.jpg');
  assert.equal(report.revision, 2);
});

test('changing non-applicable sections increments the report revision', () => {
  const report = {
    generalData: { inspectionDate: '2026-10-23', observations: '' },
    environmentalAspects: [],
    notApplicableCategories: [],
    evidence: [],
    revision: 1,
    status: 'draft',
  };
  const value = validateReportPayload(makePayload({
    notApplicableCategories: ['taller'],
  })).value;

  reconcileReportContent(report, value, 'user-1');

  assert.deepEqual(report.notApplicableCategories, ['taller']);
  assert.equal(report.revision, 2);
});

test('recognizes JPEG, PNG and WebP signatures but rejects other binary data', () => {
  assert.equal(getDetectedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(
    getDetectedImageMimeType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/png',
  );
  assert.equal(getDetectedImageMimeType(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
  assert.equal(getDetectedImageMimeType(Buffer.from('not-an-image')), null);
});
