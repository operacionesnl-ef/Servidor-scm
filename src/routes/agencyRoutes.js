const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const {
  getAgencyEmails,
  getAgencies,
  getAgencyById,
  createAgency,
  updateAgency,
  deleteAgency,
} = require('../controllers/agencyController');

const router = express.Router();

router.use(requireAuth);
router.get('/emails', getAgencyEmails);
router.get('/', getAgencies);
router.post('/', createAgency);
router.get('/:id', getAgencyById);
router.put('/:id', updateAgency);
router.patch('/:id', updateAgency);
router.delete('/:id', deleteAgency);

module.exports = router;