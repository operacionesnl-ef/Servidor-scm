'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');
const Formulario = require('../src/models/Formulario');
const { getFormularioQR } = require('../src/controllers/formularioController');
const { getPublicFormularioShortUrl } = require('../src/controllers/registroPublicoController');

function createResponse() {
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

test('assigns a stable short code for an existing form and resolves it to the original token', async (context) => {
  const originals = [
    [Formulario, {
      findById: Formulario.findById,
      findOneAndUpdate: Formulario.findOneAndUpdate,
      findOne: Formulario.findOne,
    }],
  ];
  context.after(() => originals.forEach(([target, methods]) => {
    Object.entries(methods).forEach(([name, method]) => { target[name] = method; });
  }));

  const id = new mongoose.Types.ObjectId();
  const tokenPublico = 'A'.repeat(43);
  let shortCode;
  Formulario.findById = () => ({
    select() { return this; },
    lean: async () => ({ _id: id, tokenPublico }),
  });
  Formulario.findOneAndUpdate = (_filter, update) => {
    shortCode = update.$set.codigoCorto;
    return {
      select() { return this; },
      lean: async () => ({ _id: id, codigoCorto: shortCode }),
    };
  };
  const qrResponse = createResponse();
  await getFormularioQR({ params: { id: String(id) } }, qrResponse, (error) => { throw error; });

  assert.match(shortCode, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(qrResponse.body.data.urlPublica, `/r/${shortCode}`);

  Formulario.findOne = (filter) => ({
    select() { return this; },
    lean: async () => (filter.codigoCorto === shortCode ? { tokenPublico } : null),
  });
  const resolveResponse = createResponse();
  await getPublicFormularioShortUrl(
    { params: { codigo: shortCode } },
    resolveResponse,
    (error) => { throw error; },
  );
  assert.equal(resolveResponse.body.data.tokenPublico, tokenPublico);
});

test('indexes short codes uniquely while allowing forms that have not been lazily migrated', () => {
  const index = Formulario.schema.indexes().find(([keys]) => keys.codigoCorto === 1);
  assert.equal(index?.[1]?.unique, true);
  assert.equal(index?.[1]?.sparse, true);
});
