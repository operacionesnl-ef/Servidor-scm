'use strict';

const express = require('express');
const requireAuth = require('../../../middlewares/requireAuth');
const {
  createRepReport,
  downloadRepExcel,
  getRepLogo,
  getRepExcelStatus,
  getRepReport,
  listRepReports,
  loadRepReport,
  queueRepExcel,
  receiveRepFindingImage,
  streamRepFindingImage,
  uploadRepFindingImage,
  updateRepReport,
} = require('../controllers/repController');

const router = express.Router();

router.use(requireAuth);
router.param('reportId', loadRepReport);
router.get('/logo', getRepLogo);
router.get('/', listRepReports);
router.post('/', createRepReport);
router.get('/:reportId', getRepReport);
router.put('/:reportId', updateRepReport);
router.post('/:reportId/findings/:findingId/images/:imageId', receiveRepFindingImage, uploadRepFindingImage);
router.get('/:reportId/findings/:findingId/images/:imageId', streamRepFindingImage);
router.post('/:reportId/excel/generate', queueRepExcel);
router.get('/:reportId/excel', getRepExcelStatus);
router.get('/:reportId/excel/download', downloadRepExcel);

module.exports = router;
