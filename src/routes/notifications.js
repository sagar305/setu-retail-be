const express = require('express');
const router = express.Router();

// In-memory notifications store (can be replaced with DB)
const notifications = {};

router.get('/', async (req, res) => {
  try {
    const { tenantId, user } = req;
    const userNotifications = notifications[user._id] || [];
    const unread = userNotifications.filter(n => !n.read).length;
    res.json({ notifications: userNotifications, unread });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/read', async (req, res) => {
  try {
    const { user } = req;
    const userNotifications = notifications[user._id] || [];
    const notification = userNotifications.find(n => n.id === req.params.id);
    if (notification) {
      notification.read = true;
    }
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { user } = req;
    if (notifications[user._id]) {
      notifications[user._id] = notifications[user._id].filter(n => n.id !== req.params.id);
    }
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
