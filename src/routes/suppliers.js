const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplierController');

router.get('/', supplierController.getSuppliers);
router.post('/', supplierController.createSupplier);
router.get('/stats/all', supplierController.getSupplierStats);
router.get('/:id', supplierController.getSupplierById);
router.put('/:id', supplierController.updateSupplier);
router.delete('/:id', supplierController.deleteSupplier);
router.post('/:id/payment', supplierController.recordPayment);

module.exports = router;
