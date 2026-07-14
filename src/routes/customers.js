const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');

router.get('/', customerController.getCustomers);
router.get('/search', customerController.searchCustomerByPhone);
router.post('/', customerController.createCustomer);
router.get('/:id', customerController.getCustomerById);
router.put('/:id', customerController.updateCustomer);
router.post('/:id/reward-points', customerController.addRewardPoints);
router.post('/:id/store-credit', customerController.addStoreCredit);
router.get('/:id/history', customerController.getPurchaseHistory);
router.put('/:id/membership', customerController.updateMembership);
router.get('/stats/all', customerController.getCustomerStats);

module.exports = router;
