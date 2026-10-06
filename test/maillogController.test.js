const assert = require('node:assert/strict');
const { test } = require('node:test');
const MailLog = require('../src/models/Maillog');
const { getMailLogs, getMailLogById } = require('../src/controllers/maillogController');

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('history list is scoped to the authenticated sender and returns paginated recipient results', async () => {
  const originalCount = MailLog.countDocuments;
  const originalFind = MailLog.find;
  const found = [{
    _id: '507f1f77bcf86cd799439011',
    sentBy: 'ana@example.com',
    templateKey: 'monthly',
    templateName: 'Reporte mensual',
    asuntoResuelto: 'Reporte de septiembre',
    recipients: [
      { agencyId: '507f1f77bcf86cd799439012', agencyName: 'Agencia Norte', correo: 'norte@example.com', status: 'sent' },
      { agencyId: '507f1f77bcf86cd799439013', agencyName: 'Agencia Sur', correo: 'sur@example.com', status: 'failed', error: 'Buzón lleno' },
    ],
    totalEnviados: 1,
    totalFallidos: 1,
    batchStatus: 'completed-with-errors',
    createdAt: new Date('2026-09-30T12:00:00.000Z'),
  }];
  let countFilter;
  let findFilter;
  MailLog.countDocuments = async (filter) => { countFilter = filter; return 1; };
  MailLog.find = (filter) => {
    findFilter = filter;
    return {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      select: async () => found,
    };
  };

  try {
    const response = createResponse();
    await getMailLogs({
      user: { correo: 'ana@example.com' },
      query: {
        page: '1',
        limit: '20',
        search: 'Norte',
        from: '2026-09-01',
        to: '2026-09-30',
        batchStatus: 'completed-with-errors',
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(countFilter.sentBy, 'ana@example.com');
    assert.equal(findFilter.sentBy, 'ana@example.com');
    assert.equal(findFilter.batchStatus, 'completed-with-errors');
    assert.equal(findFilter.$or.some((clause) => clause.recipients?.$elemMatch?.agencyName), true);
    assert.equal(findFilter.createdAt.$gte.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(findFilter.createdAt.$lt.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(response.body.data[0].recipientCount, 2);
    assert.equal(response.body.data[0].recipients[1].error, 'Buzón lleno');
    assert.equal(response.body.data[0].batchStatus, 'completed-with-errors');
  } finally {
    MailLog.countDocuments = originalCount;
    MailLog.find = originalFind;
  }
});

test('history rejects invalid page size and status before querying the database', async () => {
  const originalCount = MailLog.countDocuments;
  MailLog.countDocuments = async () => { throw new Error('Should not query on invalid filters'); };

  try {
    const response = createResponse();
    await getMailLogs({
      user: { correo: 'ana@example.com' },
      query: { page: '1', limit: '1000', batchStatus: 'unknown' },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /limit debe ser/);
  } finally {
    MailLog.countDocuments = originalCount;
  }
});

test('mail-log detail is only retrievable by its authenticated sender', async () => {
  const originalFindOne = MailLog.findOne;
  let query;
  MailLog.findOne = async (filter) => {
    query = filter;
    return null;
  };

  try {
    const response = createResponse();
    await getMailLogById({
      user: { correo: 'other@example.com' },
      params: { id: '507f1f77bcf86cd799439011' },
    }, response);
    assert.equal(query.sentBy, 'other@example.com');
    assert.equal(response.statusCode, 404);
  } finally {
    MailLog.findOne = originalFindOne;
  }
});
