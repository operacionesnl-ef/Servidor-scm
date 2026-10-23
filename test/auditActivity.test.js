const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const ActivityLog = require('../src/models/ActivityLog');
const auditActivity = require('../src/middlewares/auditActivity');

function makeResponse(statusCode = 200) {
  return {
    statusCode,
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('persists authenticated actions while redacting tokens from Mongo and console', async () => {
  const originalCreate = ActivityLog.create;
  const originalInfo = console.info;
  let savedEntry;
  let consoleOutput = '';
  ActivityLog.create = async (entry) => { savedEntry = entry; };
  console.info = (message) => { consoleOutput = message; };

  try {
    const req = {
      method: 'POST',
      baseUrl: '',
      path: '/api/templates',
      query: {},
      body: { nombre: 'Plantilla', googleAccessToken: 'do-not-log' },
      ip: '127.0.0.1',
      user: { _id: new mongoose.Types.ObjectId(), nombre: 'Ana', correo: 'ana@example.com', status: 'activo' },
    };
    const res = makeResponse(201);

    auditActivity(req, res, () => {});
    await res.json({ ok: true });

    assert.equal(savedEntry.accion, 'POST /api/templates');
    assert.equal(savedEntry.detalle.input.googleAccessToken, '[redacted]');
    assert.equal(res.body.ok, true);
    assert.doesNotMatch(consoleOutput, /do-not-log/);
  } finally {
    ActivityLog.create = originalCreate;
    console.info = originalInfo;
  }
});

test('coalesces identical read requests without creating more activity documents', async () => {
  const originalCreate = ActivityLog.create;
  const originalFindOneAndUpdate = ActivityLog.findOneAndUpdate;
  const originalInfo = console.info;
  let update;
  ActivityLog.create = async () => { assert.fail('read should coalesce'); };
  ActivityLog.findOneAndUpdate = async (_filter, updateDoc) => {
    update = updateDoc;
    return { _id: new mongoose.Types.ObjectId() };
  };
  console.info = () => {};

  try {
    const req = {
      method: 'GET',
      baseUrl: '',
      path: '/api/mail-jobs/active',
      query: {},
      body: {},
      ip: '127.0.0.1',
      user: { _id: new mongoose.Types.ObjectId(), nombre: 'Ana', correo: 'ana@example.com', status: 'activo' },
    };
    const res = makeResponse();

    auditActivity(req, res, () => {});
    await res.json(null);

    assert.equal(update.$inc.veces, 1);
    assert.equal(res.body, null);
  } finally {
    ActivityLog.create = originalCreate;
    ActivityLog.findOneAndUpdate = originalFindOneAndUpdate;
    console.info = originalInfo;
  }
});

test('keeps environmental report content and evidence descriptions out of activity logs', async () => {
  const originalCreate = ActivityLog.create;
  const originalInfo = console.info;
  let savedEntry;
  ActivityLog.create = async (entry) => { savedEntry = entry; };
  console.info = () => {};

  try {
    const req = {
      method: 'POST',
      baseUrl: '',
      path: '/api/for-aud-amb',
      query: {},
      body: {
        agencyId: 'agency-1',
        generalData: { inspectionDate: '2026-10-23', observations: 'contenido privado' },
        environmentalAspects: [{ aspectId: 'aspect-1', observation: 'observación privada' }],
        evidence: [{ evidenceId: 'evidence-1', description: 'descripción privada', images: [{ imageId: 'image-1' }] }],
      },
      ip: '127.0.0.1',
      user: { _id: new mongoose.Types.ObjectId(), nombre: 'Ana', correo: 'ana@example.com', status: 'activo' },
    };
    const res = makeResponse(201);

    auditActivity(req, res, () => {});
    await res.json({ ok: true });

    assert.deepEqual(savedEntry.detalle.input, {
      agencyId: 'agency-1',
      inspectionDate: '2026-10-23',
      aspectCount: 1,
      evidenceCount: 1,
      imageCount: 1,
    });
  } finally {
    ActivityLog.create = originalCreate;
    console.info = originalInfo;
  }
});