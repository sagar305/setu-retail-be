const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');

router.get('/', inventoryController.getInventory);
router.get('/stats', inventoryController.getInventoryStats);
router.get('/stock/:productId', inventoryController.getProductStock);
router.post('/adjust', inventoryController.adjustStock);
router.get('/:productId/movements', inventoryController.getMovementHistory);

module.exports = router;
