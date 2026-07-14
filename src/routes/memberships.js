const express = require('express');
const router = express.Router();
const membershipController = require('../controllers/membershipController');

router.get('/', membershipController.getMemberships);
router.get('/predefined', membershipController.getPredefinedMemberships);
router.get('/stats/all', membershipController.getMembershipStats);
router.post('/', membershipController.createMembership);
router.get('/:id', membershipController.getMembershipById);
router.put('/:id', membershipController.updateMembership);

module.exports = router;
