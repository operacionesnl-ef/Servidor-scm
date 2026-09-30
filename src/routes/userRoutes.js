const express = require('express');
const router = express.Router();
const requireAuth = require('../middlewares/requireAuth');
const { getUsers } = require('../controllers/userController');

router.get('/', requireAuth, getUsers);

module.exports = router;
