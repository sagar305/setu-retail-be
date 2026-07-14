const mongoose = require('mongoose');

const scaleSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  outletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Outlet',
  },
  name: {
    type: String,
    required: true,
  },
  brand: {
    type: String,
    enum: ['cas', 'mettler', 'baxtran', 'generic'],
    required: true,
  },
  model: String,
  serialNumber: String,

  connection: {
    type: {
      type: String,
      enum: ['usb', 'serial', 'lan', 'bluetooth'],
      required: true,
    },
    port: String,
    baudRate: {
      type: Number,
      default: 9600,
    },
    ipAddress: String,
    tcpPort: {
      type: Number,
      default: 8000,
    },
  },

  settings: {
    unitType: {
      type: String,
      enum: ['kg', 'gram', 'lb', 'oz'],
      default: 'kg',
    },
    decimalPlaces: {
      type: Number,
      default: 2,
    },
    tareWeight: {
      type: Number,
      default: 0,
    },
    maxWeight: Number,
    minWeight: Number,
    stabilityTimeout: {
      type: Number,
      default: 2000,
    },
    autoPrint: {
      type: Boolean,
      default: true,
    },
  },

  calibration: {
    lastCalibrated: Date,
    calibrationFactor: {
      type: Number,
      default: 1,
    },
    zeroOffset: {
      type: Number,
      default: 0,
    },
  },

  status: {
    type: String,
    enum: ['connected', 'disconnected', 'error', 'idle'],
    default: 'disconnected',
  },
  lastConnection: Date,
  error: String,

  isActive: {
    type: Boolean,
    default: true,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

module.exports = mongoose.model('Scale', scaleSchema);
