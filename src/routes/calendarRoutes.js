'use strict';

const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const requireAdminOrDeveloper = require('../middlewares/requireAdminOrDeveloper');
const {
  createCalendarEvent,
  createCalendarEventSeries,
  deleteCalendarEvent,
  getCalendarConsultants,
  getCalendarEvents,
  updateCalendarEvent,
} = require('../controllers/calendarController');

const router = express.Router();

router.use(requireAuth);
router.get('/consultants', getCalendarConsultants);
router.get('/events', getCalendarEvents);
router.post('/events/series', requireAdminOrDeveloper, createCalendarEventSeries);
router.post('/events', requireAdminOrDeveloper, createCalendarEvent);
router.patch('/events/:id', requireAdminOrDeveloper, updateCalendarEvent);
router.delete('/events/:id', requireAdminOrDeveloper, deleteCalendarEvent);

module.exports = router;
