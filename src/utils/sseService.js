class SSEService {
  constructor() {
    this.clients = new Map();
    this.eventHistory = [];
    this.maxHistorySize = 100;
  }

  subscribeClient(tenantId, outletId, response) {
    const key = `${tenantId}-${outletId}`;

    if (!this.clients.has(key)) {
      this.clients.set(key, []);
    }

    this.clients.get(key).push(response);

    response.on('close', () => {
      this.unsubscribeClient(tenantId, outletId, response);
    });

    response.on('error', () => {
      this.unsubscribeClient(tenantId, outletId, response);
    });

    this.sendHistoricalEvents(outletId, response);
  }

  unsubscribeClient(tenantId, outletId, response) {
    const key = `${tenantId}-${outletId}`;
    if (this.clients.has(key)) {
      const clients = this.clients.get(key).filter((client) => client !== response);
      if (clients.length === 0) {
        this.clients.delete(key);
      } else {
        this.clients.set(key, clients);
      }
    }
  }

  broadcastEvent(tenantId, outletId, eventType, data) {
    const event = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
    };

    this.addToHistory(event);

    const key = `${tenantId}-${outletId}`;
    const clients = this.clients.get(key);

    if (clients && clients.length > 0) {
      clients.forEach((response) => {
        try {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (error) {
          console.error('Error sending SSE event:', error);
        }
      });
    }
  }

  broadcastToTenant(tenantId, eventType, data) {
    const event = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
    };

    this.addToHistory(event);

    for (const [key, clients] of this.clients.entries()) {
      if (key.startsWith(tenantId)) {
        clients.forEach((response) => {
          try {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch (error) {
            console.error('Error sending SSE event:', error);
          }
        });
      }
    }
  }

  addToHistory(event) {
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }
  }

  sendHistoricalEvents(outletId, response) {
    this.eventHistory.forEach((event) => {
      try {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        console.error('Error sending historical event:', error);
      }
    });
  }

  getConnectedClients(tenantId) {
    let count = 0;
    for (const [key, clients] of this.clients.entries()) {
      if (key.startsWith(tenantId)) {
        count += clients.length;
      }
    }
    return count;
  }

  getEventHistory() {
    return this.eventHistory;
  }

  clearHistory() {
    this.eventHistory = [];
  }
}

module.exports = new SSEService();
