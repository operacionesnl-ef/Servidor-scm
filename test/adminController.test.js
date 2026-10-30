'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const AgencyRefreshJob = require('../src/models/AgencyRefreshJob');
const MailLog = require('../src/models/Maillog');
const User = require('../src/models/User');
const AuthSession = require('../src/models/AuthSession');
const {
  getDashboard,
  getSystemMetrics,
  exportCollection,
} = require('../src/controllers/adminController');

function createResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('dashboard summarizes mail, missing agency email, file data, and Drive verification', async () => {
  const originalAgencyFind = Agency.find;
  const originalMonthlyFilesFind = AgencyMonthlyFiles.find;
  const originalMailFind = MailLog.find;
  const originalAggregate = AgencyRefreshJob.aggregate;
  let mailFilter;
  let integrityPipeline;

  Agency.find = () => ({
    select() {
      return {
        lean: async () => [
          {
            _id: 'agency-1',
            nombre: 'Agencia Uno',
            correo: 'uno@example.com',
            status: 'activa',
            archivos: { carpetaPrincipal: 'root-1' },
          },
          { _id: 'agency-2', nombre: 'Agencia Dos', correo: '', status: 'inactiva' },
        ],
      };
    },
  });
  AgencyMonthlyFiles.find = (filter) => {
    assert.equal(filter.period, '2026-10');
    return {
      select() {
        return {
          lean: async () => [{
            agencyId: 'agency-1',
            archivos: {
              archivo1: { nombre: 'ANX.pdf', ruta: 'drive-1' },
              archivo3: { nombre: 'REP.pdf', ruta: 'drive-3' },
            },
          }],
        };
      },
    };
  };
  MailLog.find = (filter) => {
    mailFilter = filter;
    return {
      select() {
        return {
          lean: async () => [{
            totalEnviados: 1,
            totalFallidos: 1,
            recipients: [
              { agencyId: 'agency-1', status: 'sent' },
              { agencyId: 'agency-1', status: 'failed' },
            ],
          }],
        };
      },
    };
  };
  AgencyRefreshJob.aggregate = async (pipeline) => {
    integrityPipeline = pipeline;
    return [{
      _id: 'agency-1',
      checks: [{ status: 'ok' }, { status: 'warning' }],
      createdAt: new Date('2026-10-03T00:00:00.000Z'),
    }];
  };

  try {
    const response = createResponse();
    await getDashboard({ query: { year: '2026', month: '10' } }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.period.start.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(response.body.agencies.missingEmail, 1);
    assert.equal(response.body.agencies.emailedCount, 1);
    assert.equal(response.body.agencies.emailed[0].sentCount, 1);
    assert.equal(response.body.mail.sent, 1);
    assert.equal(response.body.mail.failed, 1);
    assert.equal(response.body.fileDataCompleteness.completeSlots, 2);
    assert.equal(response.body.fileDataCompleteness.requiredSlots, 4);
    assert.equal(response.body.fileDataCompleteness.percentage, 50);
    assert.equal(response.body.integrityVerification.percentage, 50);
    assert.equal(response.body.integrityVerification.uncheckedActiveAgencies, 0);
    assert.deepEqual(mailFilter.$or[0], { year: 2026, month: 10 });
    assert.deepEqual(mailFilter.$or[1], {
      year: { $exists: false },
      month: { $exists: false },
      createdAt: {
        $gte: new Date('2026-10-01T00:00:00.000Z'),
        $lt: new Date('2026-11-01T00:00:00.000Z'),
      },
    });
    assert.deepEqual(integrityPipeline[0].$match, {
      jobType: 'integrity',
      year: 2026,
      month: 10,
      status: { $in: ['completed', 'completed_with_issues'] },
    });
  } finally {
    Agency.find = originalAgencyFind;
    AgencyMonthlyFiles.find = originalMonthlyFilesFind;
    MailLog.find = originalMailFind;
    AgencyRefreshJob.aggregate = originalAggregate;
  }
});

test('dashboard rejects invalid calendar filters', async () => {
  const response = createResponse();
  await getDashboard({ query: { year: '2026', month: '13' } }, response, () => {
    assert.fail('invalid filter should not reach error handler');
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /month/);
});

test('system metrics compare MongoDB storage to the configured limit', async () => {
  const originalDb = mongoose.connection.db;
  const originalStorageLimit = process.env.STORAGE_LIMIT_BYTES;
  mongoose.connection.db = {
    stats: async () => ({
      collections: 5,
      objects: 20,
      dataSize: 400,
      storageSize: 512,
      indexSize: 128,
    }),
  };
  process.env.STORAGE_LIMIT_BYTES = '1024';

  try {
    const response = createResponse();
    await getSystemMetrics({}, response, (error) => { throw error; });
    assert.equal(response.body.database.storageUsagePercentage, 50);
    assert.equal(response.body.database.storageLimitBytes, 1024);
    assert.equal(response.body.process.nodeVersion, process.version);
    assert.ok(response.body.resources.memory);
    assert.ok(response.body.resources.disk.totalBytes > 0);
    assert.ok(response.body.resources.cpu.cores > 0);
    assert.equal(typeof response.body.resources.complexJobs.paused, 'boolean');
  } finally {
    mongoose.connection.db = originalDb;
    if (originalStorageLimit === undefined) delete process.env.STORAGE_LIMIT_BYTES;
    else process.env.STORAGE_LIMIT_BYTES = originalStorageLimit;
  }
});

test('JSON exports omit password hashes and unique user tokens', async () => {
  const originalFind = User.collection.find;
  let projection;
  const cursor = {
    async *[Symbol.asyncIterator]() {
      yield {
        _id: 'user-1',
        nombre: 'Ana',
        autenticacion: { proveedor: 'local', passwordHash: 'must-not-export' },
        tokenUnico: 'must-not-export-either',
      };
    },
    close: async () => {},
  };
  User.collection.find = (_filter, options) => {
    projection = options.projection;
    return cursor;
  };
  const chunks = [];
  const response = {
    headersSent: false,
    attachment(filename) { this.filename = filename; return this; },
    type(contentType) { this.contentType = contentType; return this; },
    write(chunk) { this.headersSent = true; chunks.push(chunk); return true; },
    end(chunk = '') { chunks.push(chunk); },
    destroy(error) { throw error; },
  };

  try {
    await exportCollection(
      { params: { collection: User.collection.name }, query: { format: 'json' } },
      response,
      (error) => { throw error; }
    );
    const exported = JSON.parse(chunks.join(''));
    assert.equal(projection['autenticacion.passwordHash'], 0);
    assert.equal(projection.tokenUnico, 0);
    assert.equal(exported[0].nombre, 'Ana');
    assert.equal(exported[0].autenticacion.passwordHash, undefined);
    assert.equal(exported[0].tokenUnico, undefined);
    assert.match(response.filename, /\.json$/);
  } finally {
    User.collection.find = originalFind;
  }
});

test('JSON exports never include authentication session token hashes', async () => {
  const originalFind = AuthSession.collection.find;
  let projection;
  AuthSession.collection.find = (_filter, options) => {
    projection = options.projection;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          userId: 'user-1',
          tokenHash: 'session-secret-hash',
        };
      },
      close: async () => {},
    };
  };
  const chunks = [];
  const response = {
    headersSent: false,
    attachment() { return this; },
    type() { return this; },
    write(chunk) { this.headersSent = true; chunks.push(chunk); return true; },
    end(chunk = '') { chunks.push(chunk); },
    destroy(error) { throw error; },
  };

  try {
    await exportCollection(
      { params: { collection: AuthSession.collection.name }, query: { format: 'json' } },
      response,
      (error) => { throw error; }
    );
    const exported = JSON.parse(chunks.join(''));
    assert.equal(projection.tokenHash, 0);
    assert.equal(exported[0].tokenHash, undefined);
  } finally {
    AuthSession.collection.find = originalFind;
  }
});
