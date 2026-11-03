'use strict';

const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const {
  getForReport,
  getForReportExcelStatus,
  listForReports,
  loadReport,
  downloadForReportExcel,
  queueForReportExcel,
  receiveEvidenceFile,
  removeReportImage,
  saveReportContent,
  streamReportImage,
  updateForReport,
  uploadReportImage,
} = require('../controllers/forReportController');

const router = express.Router();

router.use(requireAuth);
router.param('reportId', loadReport);
router.get('/', listForReports);
router.post('/', saveReportContent);
router.get('/:reportId', getForReport);
router.post('/:reportId/excel/generate', queueForReportExcel);
router.get('/:reportId/excel', getForReportExcelStatus);
router.get('/:reportId/excel/download', downloadForReportExcel);
router.put('/:reportId', updateForReport);
router.post('/:reportId/evidence/:evidenceId/images/:imageId', receiveEvidenceFile, uploadReportImage);
router.get('/:reportId/evidence/:evidenceId/images/:imageId', streamReportImage);
router.patch('/:reportId/evidence/:evidenceId/images/:imageId/remove', removeReportImage);

module.exports = router;
