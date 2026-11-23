const express = require('express');
const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const { getAgencyConsultantFilter } = require('../utils/agencyConsultants');
const requireAuth = require('../middlewares/requireAuth');
const requireAdminOrDeveloper = require('../middlewares/requireAdminOrDeveloper');
const {
  getAgencyMonthlyFiles,
  saveAgencyMonthlyFiles,
} = require('../controllers/agencyMonthlyFilesController');
const {
  getAgencyEmails,
  getAgencySearchPeriod,
  updateAgencySearchPeriod,
  getAgencies,
  getAgencyById,
  createAgency,
  updateAgency,
  deleteAgency,
  learnAgencyPattern,
  refreshAgencyFiles,
  createAgencyRefreshJob,
  getActiveAgencyRefreshJob,
  createAgencyIntegrityJob,
  getActiveAgencyIntegrityJob,
  getAgencyMaintenanceHistory,
  getAgencyRefreshJob,
} = require('../controllers/agencyController');
const { getAgencyHistory } = require('../controllers/agencyHistoryController');
const {
  getAgencyPersonalization,
  getAgencyTags,
  updateAgencyPersonalization,
  createAgencyTag,
  updateAgencyTag,
  deleteAgencyTag,
} = require('../controllers/agencyPersonalizationController');
const {
  appendAgencyNote,
  deleteAgencyNote,
  getAgencyNotes,
} = require('../controllers/agencyNoteController');
const {
  getMonthlyInspection,
  getMonthlyInspectionOverview,
  scheduleMonthlyVisit,
  updateMonthlyAuthorization,
  updateMonthlyVisitStatus,
  confirmMonthlyVisitAttendance,
} = require('../controllers/agencyMonthlyInspectionController');

const router = express.Router();

router.use(requireAuth);
router.use(async (req, res, next) => {
  if (req.user.rol !== 'consultor') return next();
  const allowedReadPaths = [
    /^\/$/,
    /^\/search-period$/,
    /^\/personalization$/,
    /^\/monthly-records\/[^/]+\/overview$/,
    /^\/[a-f\d]{24}$/,
    /^\/[a-f\d]{24}\/(?:history|notes)$/,
    /^\/[a-f\d]{24}\/monthly-records\/[^/]+$/,
    /^\/[a-f\d]{24}\/monthly-files\/[^/]+$/,
  ];
  const isVisitCompletion = req.method === 'PATCH'
    && /^\/[a-f\d]{24}\/monthly-records\/[^/]+\/visit$/.test(req.path)
    && req.body?.status === 'completed'
    && Object.keys(req.body || {}).length === 1;
  const isAttendanceConfirmation = req.method === 'PATCH'
    && /^\/[a-f\d]{24}\/monthly-records\/[^/]+\/attendance$/.test(req.path)
    && Object.keys(req.body || {}).length === 1
    && ['primary', 'auxiliary'].includes(req.body?.attendanceStatus);
  const isPersonalizationUpdate = req.method === 'PUT'
    && /^\/[a-f\d]{24}\/personalization$/.test(req.path);
  const isNoteAppend = req.method === 'POST'
    && /^\/[a-f\d]{24}\/notes$/.test(req.path);
  const isAllowedConsultantWrite = isVisitCompletion
    || isAttendanceConfirmation
    || isPersonalizationUpdate
    || isNoteAppend;
  if ((!isAllowedConsultantWrite && req.method !== 'GET')
    || (!isAllowedConsultantWrite && !allowedReadPaths.some((pattern) => pattern.test(req.path)))) {
    return res.status(403).json({ success: false, message: 'Los consultores solo tienen acceso de lectura a sus agencias asignadas.' });
  }
  const agencyId = req.path.match(/^\/([a-f\d]{24})(?:\/|$)/)?.[1];
  if (agencyId) {
    if (!mongoose.isValidObjectId(agencyId)) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    try {
      const assigned = await Agency.exists({
        _id: agencyId,
        ...getAgencyConsultantFilter(req.user._id),
      });
      if (!assigned) return res.status(404).json({ success: false, message: 'Agency not found' });
    } catch (error) {
      return next(error);
    }
  }
  return next();
});
router.get('/search-period', getAgencySearchPeriod);
router.put('/search-period', updateAgencySearchPeriod);
router.get('/personalization', getAgencyPersonalization);
router.get('/tags', requireAdminOrDeveloper, getAgencyTags);
router.put('/:id/personalization', updateAgencyPersonalization);
router.post('/tags', requireAdminOrDeveloper, createAgencyTag);
router.patch('/tags/:tagId', requireAdminOrDeveloper, updateAgencyTag);
router.delete('/tags/:tagId', requireAdminOrDeveloper, deleteAgencyTag);
router.get('/emails', getAgencyEmails);
router.get('/maintenance/history', getAgencyMaintenanceHistory);
router.get('/:id/notes', getAgencyNotes);
router.get('/:id/history', getAgencyHistory);
router.post('/:id/notes', appendAgencyNote);
router.delete('/:id/notes/:noteId', requireAdminOrDeveloper, deleteAgencyNote);
router.get('/:id/monthly-records/:period', getMonthlyInspection);
router.get('/:id/monthly-files/:period', getAgencyMonthlyFiles);
router.put('/:id/monthly-files/:period', requireAdminOrDeveloper, saveAgencyMonthlyFiles);
router.get('/monthly-records/:period/overview', getMonthlyInspectionOverview);
router.put('/:id/monthly-records/:period', requireAdminOrDeveloper, updateMonthlyAuthorization);
router.post('/:id/monthly-records/:period/visit', requireAdminOrDeveloper, scheduleMonthlyVisit);
router.patch('/:id/monthly-records/:period/visit', updateMonthlyVisitStatus);
router.patch('/:id/monthly-records/:period/attendance', confirmMonthlyVisitAttendance);
router.get('/', getAgencies);
router.post('/', createAgency);
router.post('/refresh-jobs', createAgencyRefreshJob);
router.get('/refresh-jobs/active', getActiveAgencyRefreshJob);
router.post('/integrity-jobs', createAgencyIntegrityJob);
router.get('/integrity-jobs/active', getActiveAgencyIntegrityJob);
router.get('/refresh-jobs/:jobId', getAgencyRefreshJob);
router.get('/integrity-jobs/:jobId', getAgencyRefreshJob);
router.get('/:id', getAgencyById);
router.put('/:id', updateAgency);
router.patch('/:id', updateAgency);
router.delete('/:id', requireAdminOrDeveloper, deleteAgency);
router.post('/:id/learn-pattern', learnAgencyPattern);
router.post('/:id/refresh-files', refreshAgencyFiles);

module.exports = router;