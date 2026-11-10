'use strict';

const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const requireAdminOrDeveloper = require('../middlewares/requireAdminOrDeveloper');
const {
  getDashboard,
  getSystemMetrics,
  getExportCollections,
  exportCollection,
  exportFullDatabase,
} = require('../controllers/adminController');

const router = express.Router();

router.use(requireAuth, requireAdminOrDeveloper);
router.get('/dashboard', getDashboard);
router.get('/system', getSystemMetrics);
router.get('/exports', getExportCollections);
router.get('/exports/database', exportFullDatabase);
router.get('/exports/:collection', exportCollection);

module.exports = router;
