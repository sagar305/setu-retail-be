const express = require('express');
const router = express.Router();
const stockTransferController = require('../controllers/stockTransferController');

router.get('/', stockTransferController.getStockTransfers);
router.post('/', stockTransferController.createStockTransfer);
router.get('/stats/all', stockTransferController.getStockTransferStats);
router.get('/:id', stockTransferController.getStockTransferById);
router.put('/:id', stockTransferController.updateStockTransfer);
router.put('/:id/approve', stockTransferController.approveStockTransfer);
router.put('/:id/ship', stockTransferController.shipStockTransfer);
router.put('/:id/receive', stockTransferController.receiveStockTransfer);
router.put('/:id/reject', stockTransferController.rejectStockTransfer);

module.exports = router;
