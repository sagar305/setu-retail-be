const express = require('express');
const router = express.Router();
const sseController = require('../controllers/sseController');

router.get('/subscribe/outlet/:outletId', sseController.subscribeToOutletEvents);
router.get('/subscribe/tenant', sseController.subscribeToTenantEvents);
router.get('/stats', sseController.getConnectionStats);
router.post('/broadcast', sseController.broadcastEvent);

module.exports = router;
