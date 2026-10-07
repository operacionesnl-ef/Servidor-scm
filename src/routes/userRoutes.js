const express = require('express');
const router = express.Router();
const requireAuth = require('../middlewares/requireAuth');
const requireDeveloper = require('../middlewares/requireDeveloper');
const {
	getUsers,
	createUser,
	updateUser,
	deactivateUser,
} = require('../controllers/userController');

router.use(requireAuth, requireDeveloper);
router.get('/', getUsers);
router.post('/', createUser);
router.put('/:id', updateUser);
router.patch('/:id', updateUser);
router.delete('/:id', deactivateUser);

module.exports = router;
