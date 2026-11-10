'use strict';

const express = require('express');
const requireAuth = require('../../../middlewares/requireAuth');
const {
  createRevReport,
  downloadRevExcel,
  getRevExcelStatus,
  getRevReport,
  listRevReports,
  loadRevReport,
  queueRevExcel,
  updateRevReport,
} = require('../controllers/revController');

const router = express.Router();
router.use(requireAuth);
router.param('reportId', loadRevReport);
router.get('/', listRevReports);
router.post('/', createRevReport);
router.get('/:reportId', getRevReport);
router.put('/:reportId', updateRevReport);
router.post('/:reportId/excel/generate', queueRevExcel);
router.get('/:reportId/excel', getRevExcelStatus);
router.get('/:reportId/excel/download', downloadRevExcel);

module.exports = router;
