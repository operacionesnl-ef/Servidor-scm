'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Template = require('../src/models/Template');
const { createTemplate, updateTemplate } = require('../src/controllers/templateController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('creates a template with normalized CC and CCO recipients', async () => {
  const originalFindOne = Template.findOne;
  const originalCreate = Template.create;
  let created;
  Template.findOne = async () => null;
  Template.create = async (value) => {
    created = value;
    return value;
  };

  try {
    const res = response();
    await createTemplate({
      body: {
        key: 'monthly',
        nombre: 'Mensual',
        cc: [' CC@example.com '],
        cco: ['hidden@example.com'],
      },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(created.cc, ['cc@example.com']);
    assert.deepEqual(created.cco, ['hidden@example.com']);
  } finally {
    Template.findOne = originalFindOne;
    Template.create = originalCreate;
  }
});

test('updates only the supplied CC and CCO fields', async () => {
  const originalFindOneAndUpdate = Template.findOneAndUpdate;
  let update;
  Template.findOneAndUpdate = async (_filter, value) => {
    update = value.$set;
    return { key: 'monthly', ...update };
  };

  try {
    const res = response();
    await updateTemplate({ params: { key: 'monthly' }, body: { cc: ['copy@example.com'] } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(update, { cc: ['copy@example.com'] });
  } finally {
    Template.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('rejects invalid template CC/CCO values without persisting', async () => {
  const originalCreate = Template.create;
  Template.create = async () => {
    throw new Error('invalid addresses must not be persisted');
  };

  try {
    const res = response();
    await createTemplate({
      body: {
        key: 'monthly',
        nombre: 'Mensual',
        cc: ['bad-address'],
      },
    }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.errors['cc.0'], 'Must be a valid email address');
  } finally {
    Template.create = originalCreate;
  }
});
