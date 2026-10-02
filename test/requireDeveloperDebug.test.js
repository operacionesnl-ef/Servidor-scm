const assert = require('node:assert/strict');
const { test } = require('node:test');
const requireDeveloperDebug = require('../src/middlewares/requireDeveloperDebug');

function invokeMiddleware(user) {
  let statusCode = 200;
  let body;
  let nextCalled = false;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  requireDeveloperDebug({ user }, response, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

test('developer debug access requires development and developer role', () => {
  const originalEnvironment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    assert.equal(invokeMiddleware({ rol: 'developer' }).nextCalled, true);
    assert.equal(invokeMiddleware({ rol: 'admin' }).statusCode, 403);

    process.env.NODE_ENV = 'production';
    assert.equal(invokeMiddleware({ rol: 'developer' }).statusCode, 404);
  } finally {
    process.env.NODE_ENV = originalEnvironment;
  }
});