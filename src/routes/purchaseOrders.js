const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrderController');

router.get('/', purchaseOrderController.getPurchaseOrders);
router.post('/', purchaseOrderController.createPurchaseOrder);
router.get('/stats/all', purchaseOrderController.getPurchaseOrderStats);
router.get('/:id', purchaseOrderController.getPurchaseOrderById);
router.put('/:id', purchaseOrderController.updatePurchaseOrder);
router.put('/:id/confirm', purchaseOrderController.confirmPurchaseOrder);
router.put('/:id/receive', purchaseOrderController.receivePurchaseOrder);
router.put('/:id/cancel', purchaseOrderController.cancelPurchaseOrder);

module.exports = router;
