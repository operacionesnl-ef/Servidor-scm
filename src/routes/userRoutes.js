const express = require('express');
const router = express.Router();
const requireAuth = require('../middlewares/requireAuth');
const requireDeveloperDebug = require('../middlewares/requireDeveloperDebug');
const {
	getUsers,
	createUser,
	updateUser,
	deactivateUser,
} = require('../controllers/userController');

router.use(requireAuth, requireDeveloperDebug);
router.get('/', getUsers);
router.post('/', createUser);
router.put('/:id', updateUser);
router.patch('/:id', updateUser);
router.delete('/:id', deactivateUser);

module.exports = router;
