'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const { getHealth } = require('../src/controllers/healthController');

function createResponse() {
  return {
    statusCode: null,
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

test('health endpoint returns HTTP 200 when MongoDB is connected', () => {
  const originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  try {
    const response = createResponse();
    getHealth({}, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.database, 'connected');
    assert.equal(typeof response.body.timestamp, 'string');
    assert.equal(typeof response.body.uptimeSeconds, 'number');
  } finally {
    mongoose.connection.readyState = originalReadyState;
  }
});

test('health endpoint returns HTTP 503 when MongoDB is disconnected', () => {
  const originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 0;

  try {
    const response = createResponse();
    getHealth({}, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.status, 'degraded');
    assert.equal(response.body.database, 'disconnected');
  } finally {
    mongoose.connection.readyState = originalReadyState;
  }
});
