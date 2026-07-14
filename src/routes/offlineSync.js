const express = require('express');
const router = express.Router();
const offlineSyncController = require('../controllers/offlineSyncController');

router.get('/queue', offlineSyncController.getOfflineQueue);
router.get('/pending', offlineSyncController.getPendingActions);
router.get('/status', offlineSyncController.getSyncStatus);
router.post('/queue', offlineSyncController.addToOfflineQueue);
router.post('/sync', offlineSyncController.syncOfflineData);
router.post('/retry', offlineSyncController.retryFailedActions);
router.delete('/queue/:queueId', offlineSyncController.removeQueueItem);
router.delete('/queue', offlineSyncController.clearOfflineQueue);

module.exports = router;
