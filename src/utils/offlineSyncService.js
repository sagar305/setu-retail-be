const fs = require('fs');
const path = require('path');

class OfflineSyncService {
  constructor() {
    this.queueDir = path.join(__dirname, '../../data/sync-queue');
    this.ensureQueueDir();
  }

  ensureQueueDir() {
    if (!fs.existsSync(this.queueDir)) {
      fs.mkdirSync(this.queueDir, { recursive: true });
    }
  }

  getQueueFile(tenantId) {
    return path.join(this.queueDir, `${tenantId}-queue.json`);
  }

  addToQueue(tenantId, action) {
    try {
      const queueFile = this.getQueueFile(tenantId);
      let queue = [];

      if (fs.existsSync(queueFile)) {
        const data = fs.readFileSync(queueFile, 'utf-8');
        queue = JSON.parse(data);
      }

      const queueItem = {
        id: `${Date.now()}-${Math.random()}`,
        action: action.action,
        endpoint: action.endpoint,
        method: action.method || 'POST',
        payload: action.payload,
        timestamp: new Date(),
        retries: 0,
        maxRetries: 3,
        status: 'pending',
      };

      queue.push(queueItem);
      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));

      return {
        success: true,
        queueId: queueItem.id,
        message: 'Action queued for offline sync',
      };
    } catch (error) {
      console.error('Queue add error:', error);
      return { success: false, error: error.message };
    }
  }

  getQueue(tenantId) {
    try {
      const queueFile = this.getQueueFile(tenantId);

      if (!fs.existsSync(queueFile)) {
        return { success: true, queue: [] };
      }

      const data = fs.readFileSync(queueFile, 'utf-8');
      const queue = JSON.parse(data);

      return {
        success: true,
        queue,
        total: queue.length,
        pending: queue.filter((q) => q.status === 'pending').length,
        failed: queue.filter((q) => q.status === 'failed').length,
      };
    } catch (error) {
      console.error('Queue read error:', error);
      return { success: false, error: error.message };
    }
  }

  updateQueueItem(tenantId, queueId, updates) {
    try {
      const queueFile = this.getQueueFile(tenantId);
      let queue = [];

      if (fs.existsSync(queueFile)) {
        const data = fs.readFileSync(queueFile, 'utf-8');
        queue = JSON.parse(data);
      }

      const itemIndex = queue.findIndex((q) => q.id === queueId);
      if (itemIndex === -1) {
        return { success: false, error: 'Queue item not found' };
      }

      queue[itemIndex] = { ...queue[itemIndex], ...updates };
      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));

      return { success: true, item: queue[itemIndex] };
    } catch (error) {
      console.error('Queue update error:', error);
      return { success: false, error: error.message };
    }
  }

  removeFromQueue(tenantId, queueId) {
    try {
      const queueFile = this.getQueueFile(tenantId);
      let queue = [];

      if (fs.existsSync(queueFile)) {
        const data = fs.readFileSync(queueFile, 'utf-8');
        queue = JSON.parse(data);
      }

      queue = queue.filter((q) => q.id !== queueId);
      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));

      return { success: true, message: 'Item removed from queue' };
    } catch (error) {
      console.error('Queue remove error:', error);
      return { success: false, error: error.message };
    }
  }

  clearQueue(tenantId) {
    try {
      const queueFile = this.getQueueFile(tenantId);

      if (fs.existsSync(queueFile)) {
        fs.unlinkSync(queueFile);
      }

      return { success: true, message: 'Queue cleared' };
    } catch (error) {
      console.error('Queue clear error:', error);
      return { success: false, error: error.message };
    }
  }

  getPendingActions(tenantId) {
    try {
      const queueFile = this.getQueueFile(tenantId);

      if (!fs.existsSync(queueFile)) {
        return { success: true, actions: [] };
      }

      const data = fs.readFileSync(queueFile, 'utf-8');
      const queue = JSON.parse(data);
      const pending = queue.filter((q) => q.status === 'pending' && q.retries < q.maxRetries);

      return { success: true, actions: pending };
    } catch (error) {
      console.error('Pending actions error:', error);
      return { success: false, error: error.message };
    }
  }

  retryFailedActions(tenantId) {
    try {
      const queueFile = this.getQueueFile(tenantId);

      if (!fs.existsSync(queueFile)) {
        return { success: true, retried: 0 };
      }

      const data = fs.readFileSync(queueFile, 'utf-8');
      let queue = JSON.parse(data);

      const failedItems = queue.filter((q) => q.status === 'failed' && q.retries < q.maxRetries);

      failedItems.forEach((item) => {
        item.status = 'pending';
        item.retries += 1;
      });

      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));

      return { success: true, retried: failedItems.length };
    } catch (error) {
      console.error('Retry failed error:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new OfflineSyncService();
