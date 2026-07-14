let SerialPort;
try {
  SerialPort = require('serialport');
} catch (error) {
  SerialPort = null;
}
const net = require('net');
const barcodeService = require('./barcodeService');

class ScaleService {
  constructor() {
    this.activeConnections = new Map();
    this.weightBuffer = new Map();
    this.stabilityTimers = new Map();
  }

  async connectScale(scale) {
    const connectionKey = `${scale._id}`;

    try {
      let connection;

      switch (scale.connection.type) {
        case 'serial':
          connection = await this.connectSerial(scale);
          break;
        case 'usb':
          connection = await this.connectUSB(scale);
          break;
        case 'lan':
          connection = await this.connectLAN(scale);
          break;
        case 'bluetooth':
          connection = await this.connectBluetooth(scale);
          break;
        default:
          throw new Error(`Unsupported connection type: ${scale.connection.type}`);
      }

      this.activeConnections.set(connectionKey, connection);
      this.weightBuffer.set(connectionKey, []);

      connection.on('data', (data) => this.handleData(connectionKey, data, scale));
      connection.on('error', (error) => this.handleError(connectionKey, error, scale));
      connection.on('close', () => this.handleClose(connectionKey, scale));

      return { success: true, message: 'Scale connected' };
    } catch (error) {
      console.error(`Scale connection error for ${scale.name}:`, error);
      return { success: false, error: error.message };
    }
  }

  async connectSerial(scale) {
    if (!SerialPort) {
      return this.createMockSerialPort(scale);
    }

    const { port, baudRate } = scale.connection;
    return new Promise((resolve, reject) => {
      const serialPort = new SerialPort.SerialPort({
        path: port,
        baudRate: baudRate || 9600,
        autoOpen: true,
      });

      serialPort.on('open', () => resolve(serialPort));
      serialPort.on('error', reject);
    });
  }

  createMockSerialPort(scale) {
    let lastWeight = 0;
    const mockPort = {
      on: (event, callback) => {
        if (event === 'data') {
          this.mockDataCallback = callback;
        }
        if (event === 'error') {
          this.mockErrorCallback = callback;
        }
        if (event === 'close') {
          this.mockCloseCallback = callback;
        }
      },
      write: () => {},
      close: () => {
        if (this.mockCloseCallback) {
          this.mockCloseCallback();
        }
      },
      destroy: () => {
        if (this.mockCloseCallback) {
          this.mockCloseCallback();
        }
      },
      simulateWeight: (weight) => {
        lastWeight = weight;
        if (this.mockDataCallback) {
          this.mockDataCallback(Buffer.from(weight.toString()));
        }
      },
    };
    return mockPort;
  }

  async connectUSB(scale) {
    return this.connectSerial(scale);
  }

  async connectLAN(scale) {
    const { ipAddress, tcpPort } = scale.connection;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(tcpPort || 8000, ipAddress);
      socket.on('connect', () => resolve(socket));
      socket.on('error', reject);
    });
  }

  async connectBluetooth(scale) {
    throw new Error('Bluetooth connection requires additional setup. Use SerialPort over virtual serial port.');
  }

  handleData(connectionKey, data, scale) {
    try {
      const weightStr = data.toString().trim();
      const weight = parseFloat(weightStr);

      if (!isNaN(weight)) {
        this.weightBuffer.set(connectionKey, [weight]);
        this.checkStability(connectionKey, scale);
      }
    } catch (error) {
      console.error('Scale data parsing error:', error);
    }
  }

  checkStability(connectionKey, scale) {
    clearTimeout(this.stabilityTimers.get(connectionKey));

    const timerId = setTimeout(() => {
      const buffer = this.weightBuffer.get(connectionKey);
      if (buffer && buffer.length > 0) {
        const averageWeight = buffer.reduce((a, b) => a + b) / buffer.length;
        this.broadcastWeight(scale._id, averageWeight, scale.settings);
      }
    }, scale.settings.stabilityTimeout || 2000);

    this.stabilityTimers.set(connectionKey, timerId);
  }

  broadcastWeight(scaleId, weight, settings) {
    const adjustedWeight = weight * (settings.decimalPlaces ? 1 : 1);
    return {
      scaleId,
      weight: parseFloat(adjustedWeight.toFixed(settings.decimalPlaces || 2)),
      unitType: settings.unitType,
      timestamp: new Date(),
    };
  }

  async handleError(connectionKey, error, scale) {
    console.error(`Scale error for ${scale.name}:`, error);
  }

  async handleClose(connectionKey, scale) {
    this.activeConnections.delete(connectionKey);
    this.weightBuffer.delete(connectionKey);
    clearTimeout(this.stabilityTimers.get(connectionKey));
    this.stabilityTimers.delete(connectionKey);
    console.log(`Scale disconnected: ${scale.name}`);
  }

  async disconnectScale(scaleId) {
    const connectionKey = `${scaleId}`;
    const connection = this.activeConnections.get(connectionKey);

    if (connection) {
      if (connection.close) {
        connection.close();
      } else if (connection.destroy) {
        connection.destroy();
      }
      return { success: true, message: 'Scale disconnected' };
    }

    return { success: false, error: 'Scale not connected' };
  }

  async getWeight(scaleId) {
    const connectionKey = `${scaleId}`;
    const buffer = this.weightBuffer.get(connectionKey);

    if (buffer && buffer.length > 0) {
      const weight = buffer[buffer.length - 1];
      return { success: true, weight };
    }

    return { success: false, error: 'No weight data available' };
  }

  async tare(scaleId) {
    const weight = await this.getWeight(scaleId);
    if (weight.success) {
      return { success: true, taredWeight: weight.weight };
    }
    return { success: false, error: 'Cannot tare: scale not ready' };
  }

  async generateWeightBarcode(scaleId, sku, pricePerKg) {
    const weight = await this.getWeight(scaleId);
    if (!weight.success) {
      return { success: false, error: 'Cannot generate barcode: no weight data' };
    }

    const totalPrice = weight.weight * pricePerKg;
    const barcode = barcodeService.generateWeightBasedBarcode(sku, weight.weight, totalPrice);

    return {
      success: true,
      barcode,
      weight: weight.weight,
      price: totalPrice,
      sku,
    };
  }

  async printBarcode(scaleId, sku, productName, pricePerKg) {
    const barcodeData = await this.generateWeightBarcode(scaleId, sku, pricePerKg);

    if (!barcodeData.success) {
      return barcodeData;
    }

    try {
      const png = await barcodeService.generateEAN13(barcodeData.barcode);

      if (png.success) {
        return {
          success: true,
          barcode: barcodeData.barcode,
          image: png.buffer.toString('base64'),
          weight: barcodeData.weight,
          price: barcodeData.price,
        };
      }
    } catch (error) {
      console.error('Barcode generation error:', error);
      return { success: false, error: error.message };
    }
  }

  getConnectedScales() {
    return Array.from(this.activeConnections.keys()).map((key) => ({
      scaleId: key,
      connected: true,
    }));
  }

  isConnected(scaleId) {
    const connectionKey = `${scaleId}`;
    return this.activeConnections.has(connectionKey);
  }
}

module.exports = new ScaleService();
