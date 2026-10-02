const assert = require('node:assert/strict');
const { test } = require('node:test');
const ActivityLog = require('../src/models/ActivityLog');
const { getServerLogs } = require('../src/controllers/serverLogController');

test('returns paginated, sanitized all-user request audit entries', async () => {
  const originalFind = ActivityLog.find;
  const entries = [{
    _id: '507f1f77bcf86cd799439011',
    accion: 'POST /api/users',
    fecha: new Date('2026-10-02T12:00:00.000Z'),
    ultimaFecha: new Date('2026-10-02T12:01:00.000Z'),
    veces: 2,
    usuarioNombre: 'Ana',
    usuarioCorreo: 'ana@example.com',
    detalle: {
      method: 'POST',
      path: '/api/users',
      statusCode: 201,
      input: { correo: 'ana@example.com', credential: 'must-not-be-returned' },
    },
  }];
  ActivityLog.find = () => ({
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => entries,
  });

  try {
    let responseBody;
    let statusCode = 200;
    const response = {
      status(code) { statusCode = code; return this; },
      json(body) { responseBody = body; return this; },
    };
    await getServerLogs({ query: { source: 'activity', limit: '50' } }, response, (error) => { throw error; });

    assert.equal(statusCode, 200);
    assert.equal(responseBody.events[0].action, 'POST /api/users');
    assert.equal(responseBody.events[0].detail.statusCode, 201);
    assert.equal(responseBody.events[0].detail.input, undefined);
    assert.equal(responseBody.nextCursor, null);
  } finally {
    ActivityLog.find = originalFind;
  }
});