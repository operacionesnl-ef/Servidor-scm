'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const AgencyHistory = require('../src/models/AgencyHistory');
const AgencyMonthlyInspection = require('../src/models/AgencyMonthlyInspection');
const CalendarEvent = require('../src/models/CalendarEvent');
const Notification = require('../src/models/Notification');
const Subscription = require('../src/models/Subscription');
const { confirmMonthlyVisitAttendance } = require('../src/controllers/agencyMonthlyInspectionController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('the assigned auxiliary confirms attendance and both consultants receive distinct notices', async () => {
  const originals = {
    agencyFindOne: Agency.findOne,
    inspectionFindOne: AgencyMonthlyInspection.findOne,
    calendarEventExists: CalendarEvent.exists,
    historyCreate: AgencyHistory.create,
    notificationFindOneAndUpdate: Notification.findOneAndUpdate,
    subscriptionExists: Subscription.exists,
  };
  const agencyId = new mongoose.Types.ObjectId();
  const eventId = new mongoose.Types.ObjectId();
  const principalId = new mongoose.Types.ObjectId();
  const auxiliaryId = new mongoose.Types.ObjectId();
  const notices = [];
  const agency = {
    _id: agencyId,
    nombre: 'Agencia Compartida',
    consultantId: principalId,
    auxiliaryConsultantId: auxiliaryId,
  };
  const record = {
    _id: new mongoose.Types.ObjectId(),
    agencyId,
    period: '2026-11',
    authorizationStatus: 'authorized',
    visitStatus: 'scheduled',
    attendanceStatus: 'pending',
    calendarEventId: eventId,
    async save() { this.updatedAt = new Date(); },
  };
  Agency.findOne = () => ({ select: async () => agency });
  AgencyMonthlyInspection.findOne = async () => record;
  CalendarEvent.exists = async () => true;
  AgencyHistory.create = async (entry) => entry;
  Notification.findOneAndUpdate = async (_filter, update) => {
    notices.push(update.$setOnInsert);
    return { _id: new mongoose.Types.ObjectId(), ...update.$setOnInsert };
  };
  Subscription.exists = async () => false;

  try {
    const res = response();
    await confirmMonthlyVisitAttendance({
      params: { id: String(agencyId), period: '2026-11' },
      body: { attendanceStatus: 'auxiliary' },
      user: { _id: auxiliaryId, rol: 'consultor' },
    }, res, (error) => { throw error; });

    const auxiliaryNotice = notices.find(({ recipientUserId }) => (
      String(recipientUserId) === String(auxiliaryId)
    ));
    assert.equal(res.statusCode, 200);
    assert.equal(record.attendanceStatus, 'auxiliary');
    assert.equal(String(record.attendanceConfirmedBy), String(auxiliaryId));
    assert.equal(notices.length, 2);
    assert.equal(auxiliaryNotice.title, 'Confirmaste la asistencia');
    assert.match(auxiliaryNotice.message, /consultor auxiliar/);
    assert.notEqual(notices[0].idempotencyKey, notices[1].idempotencyKey);
  } finally {
    Agency.findOne = originals.agencyFindOne;
    AgencyMonthlyInspection.findOne = originals.inspectionFindOne;
    CalendarEvent.exists = originals.calendarEventExists;
    AgencyHistory.create = originals.historyCreate;
    Notification.findOneAndUpdate = originals.notificationFindOneAndUpdate;
    Subscription.exists = originals.subscriptionExists;
  }
});
