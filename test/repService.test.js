'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateRepPayload } = require('../src/formatosGeneradores/rep/services/repService');

function payload(overrides = {}) {
  return {
    generalData: {
      inspectionDate: '2026-10-29',
      startDate: '2026-10-29',
      endDate: '2026-10-29',
      visitType: 'ordinario',
      startTime: '08:00',
      endTime: '10:00',
      areas: 'Patio',
    },
    findings: [{
      area: 'Patio',
      element: 'Extintor',
      correctiveAction: 'Reponer',
      preventiveAction: 'Inspeccionar mensualmente',
      priority: 'alta',
      legalBasis: 'Ley Federal del Trabajo, artículo 132',
      onTime: true,
      findingDate: '2026-10-29',
      dueDate: '2026-11-05',
    }],
    documents: { estudio_iluminacion: 'Cumple' },
    ...overrides,
  };
}

test('validates and normalizes REP data, including separate corrective and preventive actions', () => {
  const result = validateRepPayload(payload());
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.findings[0].correctiveAction, 'Reponer');
  assert.equal(result.value.findings[0].preventiveAction, 'Inspeccionar mensualmente');
  assert.equal(result.value.findings[0].onTime, 'Sí');
  assert.equal(result.value.documents.estudio_iluminacion, 'Cumple');
});

test('accepts a due date before the finding date', () => {
  const result = validateRepPayload(payload({
    findings: [{
      area: 'Patio',
      element: 'Extintor',
      legalBasis: 'NOM-002-STPS-2010',
      findingDate: '2026-10-29',
      dueDate: '2026-10-01',
    }],
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.findings[0].dueDate, '2026-10-01');
});

test('requires a non-empty legal basis for every finding', () => {
  const result = validateRepPayload(payload({
    findings: [{ area: 'Patio', element: 'Extintor', legalBasis: '   ' }],
  }));
  assert.ok(result.errors.some((error) => error.includes('fundamento legal') && error.includes('obligatorio')));
});

test('rejects invalid inspection dates, conflicting visit types, and unknown document fields', () => {
  const result = validateRepPayload(payload({
    generalData: { inspectionDate: '2026-02-30', visitType: 'ambos' },
    documents: { otro: 'dato' },
  }));
  assert.ok(result.errors.some((error) => error.includes('fecha')));
  assert.ok(result.errors.some((error) => error.includes('tipo de recorrido')));
  assert.ok(result.errors.some((error) => error.includes('campos desconocidos')));
});

test('accepts reports without findings and enforces the finding-count ceiling', () => {
  assert.deepEqual(validateRepPayload(payload({ findings: [] })).errors, []);
  const result = validateRepPayload(payload({ findings: Array.from({ length: 501 }, () => ({})) }));
  assert.ok(result.errors.some((error) => error.includes('hasta 40')));
});

test('validates pending finding photos without accepting unsupported image metadata', () => {
  const image = {
    imageId: 'photo-12345678',
    fileName: 'evidencia.jpg',
    mimeType: 'image/jpeg',
    status: 'pending',
  };
  const valid = validateRepPayload(payload({
    findings: [{ area: 'Patio', element: 'Extintor', legalBasis: 'NOM-002-STPS-2010', findingId: 'finding-123456', images: [image] }],
  }));
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.value.findings[0].images[0].imageId, image.imageId);

  const fourPhotos = Array.from({ length: 4 }, (_, index) => ({
    ...image,
    imageId: `photo-id-12345${index}`,
  }));
  const validFour = validateRepPayload(payload({
    findings: [{ area: 'Patio', element: 'Extintor', legalBasis: 'NOM-002-STPS-2010', findingId: 'finding-123456', images: fourPhotos }],
  }));
  assert.deepEqual(validFour.errors, []);
  assert.equal(validFour.value.findings[0].images.length, 4);

  const invalid = validateRepPayload(payload({
    findings: [{ area: 'Patio', element: 'Extintor', images: [{ ...image, mimeType: 'text/plain' }] }],
  }));
  assert.ok(invalid.errors.some((error) => error.includes('foto')));
  const tooMany = validateRepPayload(payload({
    findings: [{ area: 'Patio', element: 'Extintor', images: Array.from({ length: 5 }, (_, index) => ({ ...image, imageId: `photo-id-12345${index}` })) }],
  }));
  assert.ok(tooMany.errors.some((error) => error.includes('hasta 4 fotos')));
});
