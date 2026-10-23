'use strict';

const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const requireAdminOrDeveloper = require('../middlewares/requireAdminOrDeveloper');
const {
  completeGoogleDriveAuthorization,
  getGoogleDriveStatus,
  startGoogleDriveAuthorization,
} = require('../controllers/googleDriveController');

const router = express.Router();

router.use(requireAuth, requireAdminOrDeveloper);
router.get('/auth', startGoogleDriveAuthorization);
router.get('/callback', completeGoogleDriveAuthorization);
router.get('/status', getGoogleDriveStatus);

module.exports = router;
