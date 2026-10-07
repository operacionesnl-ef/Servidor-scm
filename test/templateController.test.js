'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Template = require('../src/models/Template');
const { createTemplate, updateTemplate } = require('../src/controllers/templateController');

function createResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('creates a template with its configured optional files', async () => {
  const originalFindOne = Template.findOne;
  const originalCreate = Template.create;
  Template.findOne = async () => null;
  Template.create = async (data) => data;

  try {
    const response = createResponse();
    await createTemplate({
      body: {
        key: 'mensual',
        nombre: 'Reporte mensual',
        archivosIndividuales: ['ANX', 'FOR'],
        archivosOpcionales: ['ANX'],
      },
    }, response);

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.body.data.archivosOpcionales, ['ANX']);
  } finally {
    Template.findOne = originalFindOne;
    Template.create = originalCreate;
  }
});

test('rejects optional files that are not selected as individual attachments', async () => {
  const response = createResponse();
  await createTemplate({
    body: {
      key: 'mensual',
      nombre: 'Reporte mensual',
      archivosIndividuales: ['FOR'],
      archivosOpcionales: ['ANX'],
    },
  }, response);

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /archivos individuales incluidos/);
});

test('updates optional files while preserving the selected individual files', async () => {
  const originalFindOne = Template.findOne;
  const originalFindOneAndUpdate = Template.findOneAndUpdate;
  const current = { archivosIndividuales: ['ANX', 'FOR'], archivosOpcionales: [] };
  Template.findOne = () => ({ select: async () => current });
  Template.findOneAndUpdate = async (_filter, update) => ({ ...current, ...update.$set });

  try {
    const response = createResponse();
    await updateTemplate({
      params: { key: 'mensual' },
      body: { archivosOpcionales: ['ANX'] },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.data.archivosIndividuales, ['ANX', 'FOR']);
    assert.deepEqual(response.body.data.archivosOpcionales, ['ANX']);
  } finally {
    Template.findOne = originalFindOne;
    Template.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('rejects updates that make an optional file unselected', async () => {
  const originalFindOne = Template.findOne;
  Template.findOne = () => ({
    select: async () => ({ archivosIndividuales: ['FOR'], archivosOpcionales: [] }),
  });

  try {
    const response = createResponse();
    await updateTemplate({
      params: { key: 'mensual' },
      body: { archivosOpcionales: ['ANX'] },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /archivos individuales incluidos/);
  } finally {
    Template.findOne = originalFindOne;
  }
});
