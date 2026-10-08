const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
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

const router = express.Router();

router.use(requireAuth);
router.get('/search-period', getAgencySearchPeriod);
router.put('/search-period', updateAgencySearchPeriod);
router.get('/emails', getAgencyEmails);
router.get('/', getAgencies);
router.post('/', createAgency);
router.post('/refresh-jobs', createAgencyRefreshJob);
router.get('/refresh-jobs/active', getActiveAgencyRefreshJob);
router.get('/maintenance/history', getAgencyMaintenanceHistory);
router.post('/integrity-jobs', createAgencyIntegrityJob);
router.get('/integrity-jobs/active', getActiveAgencyIntegrityJob);
router.get('/refresh-jobs/:jobId', getAgencyRefreshJob);
router.get('/integrity-jobs/:jobId', getAgencyRefreshJob);
router.get('/:id', getAgencyById);
router.put('/:id', updateAgency);
router.patch('/:id', updateAgency);
router.delete('/:id', deleteAgency);
router.post('/:id/learn-pattern', learnAgencyPattern);
router.post('/:id/refresh-files', refreshAgencyFiles);

module.exports = router;