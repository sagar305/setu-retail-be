const sseService = require('../utils/sseService');

exports.subscribeToOutletEvents = (req, res) => {
  try {
    const { outletId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    sseService.subscribeClient(req.tenantId, outletId, res);

    const keepAliveInterval = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch (error) {
        clearInterval(keepAliveInterval);
      }
    }, 30000);

    res.on('close', () => {
      clearInterval(keepAliveInterval);
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.subscribeToTenantEvents = (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    sseService.subscribeClient(req.tenantId, 'global', res);

    const keepAliveInterval = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch (error) {
        clearInterval(keepAliveInterval);
      }
    }, 30000);

    res.on('close', () => {
      clearInterval(keepAliveInterval);
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getConnectionStats = (req, res) => {
  try {
    const connectedClients = sseService.getConnectedClients(req.tenantId);
    const eventHistory = sseService.getEventHistory();

    res.json({
      connectedClients,
      eventHistorySize: eventHistory.length,
      lastEvents: eventHistory.slice(-10),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.broadcastEvent = (req, res) => {
  try {
    const { eventType, data, broadcastTo } = req.body;

    if (!eventType || !data) {
      return res.status(400).json({ message: 'eventType and data are required' });
    }

    if (broadcastTo === 'outlet' && req.body.outletId) {
      sseService.broadcastEvent(req.tenantId, req.body.outletId, eventType, data);
    } else {
      sseService.broadcastToTenant(req.tenantId, eventType, data);
    }

    res.json({ success: true, message: 'Event broadcasted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
