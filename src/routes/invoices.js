const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');

router.get('/', invoiceController.getInvoices);
router.post('/', invoiceController.createInvoice);
router.get('/:id', invoiceController.getInvoiceById);
router.get('/reports/sales', invoiceController.getSalesReport);
router.get('/reports/top-selling', invoiceController.getTopSellingProducts);

module.exports = router;
