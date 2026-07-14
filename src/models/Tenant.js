const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  phone: {
    type: String,
    required: true,
  },
  businessName: {
    type: String,
    required: true,
  },
  gst: String,
  logo: String,
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    country: String,
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'basic', 'pro', 'enterprise'],
      default: 'free',
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'trial'],
      default: 'trial',
    },
    startDate: Date,
    endDate: Date,
  },
  settings: {
    currency: {
      type: String,
      default: 'INR',
    },
    timezone: {
      type: String,
      default: 'Asia/Kolkata',
    },
    dateFormat: {
      type: String,
      default: 'DD/MM/YYYY',
    },
    language: {
      type: String,
      default: 'en',
    },
    sessionTimeout: {
      type: Number,
      default: 10,
    },
    offlineMode: {
      type: Boolean,
      default: true,
    },
    lowStockNotification: {
      enabled: Boolean,
      frequency: String,
    },
    expiryNotification: {
      enabled: Boolean,
      days: Number,
    },
  },
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

module.exports = mongoose.model('Tenant', tenantSchema);
