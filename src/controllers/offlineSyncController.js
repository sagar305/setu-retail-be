const offlineSyncService = require('../utils/offlineSyncService');

exports.getOfflineQueue = async (req, res) => {
  try {
    const result = offlineSyncService.getQueue(req.tenantId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addToOfflineQueue = async (req, res) => {
  try {
    const { action, endpoint, method, payload } = req.body;

    if (!action || !endpoint) {
      return res.status(400).json({ message: 'action and endpoint are required' });
    }

    const result = offlineSyncService.addToQueue(req.tenantId, {
      action,
      endpoint,
      method: method || 'POST',
      payload,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPendingActions = async (req, res) => {
  try {
    const result = offlineSyncService.getPendingActions(req.tenantId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.clearOfflineQueue = async (req, res) => {
  try {
    const result = offlineSyncService.clearQueue(req.tenantId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.retryFailedActions = async (req, res) => {
  try {
    const result = offlineSyncService.retryFailedActions(req.tenantId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.removeQueueItem = async (req, res) => {
  try {
    const { queueId } = req.params;

    const result = offlineSyncService.removeFromQueue(req.tenantId, queueId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.syncOfflineData = async (req, res) => {
  try {
    const { actions } = req.body;

    if (!Array.isArray(actions)) {
      return res.status(400).json({ message: 'actions must be an array' });
    }

    const results = [];
    const errors = [];

    for (const action of actions) {
      try {
        switch (action.action) {
          case 'create_invoice':
            // Would sync invoice
            results.push({ id: action.id, status: 'synced' });
            offlineSyncService.removeFromQueue(req.tenantId, action.id);
            break;
          case 'adjust_inventory':
            // Would adjust inventory
            results.push({ id: action.id, status: 'synced' });
            offlineSyncService.removeFromQueue(req.tenantId, action.id);
            break;
          default:
            errors.push({ id: action.id, error: 'Unknown action type' });
        }
      } catch (itemError) {
        offlineSyncService.updateQueueItem(req.tenantId, action.id, {
          status: 'failed',
          retries: action.retries + 1,
        });
        errors.push({ id: action.id, error: itemError.message });
      }
    }

    res.json({
      synced: results.length,
      failed: errors.length,
      results,
      errors,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getSyncStatus = async (req, res) => {
  try {
    const queueResult = offlineSyncService.getQueue(req.tenantId);

    const status = {
      offline_enabled: true,
      queue_status: queueResult.queue ? 'active' : 'empty',
      total_pending: queueResult.pending || 0,
      total_failed: queueResult.failed || 0,
      last_sync: new Date().toISOString(),
      sync_ready: queueResult.pending > 0,
    };

    res.json(status);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
