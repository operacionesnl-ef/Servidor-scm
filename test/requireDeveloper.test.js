'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const requireDeveloper = require('../src/middlewares/requireDeveloper');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('global notification publishing requires the developer role in every environment', () => {
  const res = response();
  let proceeded = false;

  requireDeveloper({ user: { rol: 'admin' } }, res, () => { proceeded = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(proceeded, false);
});

test('developers pass the broadcast authorization middleware', () => {
  const res = response();
  let proceeded = false;

  requireDeveloper({ user: { rol: 'developer' } }, res, () => { proceeded = true; });

  assert.equal(proceeded, true);
  assert.equal(res.statusCode, 200);
});
