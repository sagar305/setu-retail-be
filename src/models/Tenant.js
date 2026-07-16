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
  // Free-form settings bag: sections are managed by the Settings page
  // (business, branding, tax, inventory, printer, cashDrawer, localization, audit, barcodeScale)
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
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
