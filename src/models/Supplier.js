const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  phone: String,
  email: String,
  gst: String,
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
  },
  outstandingBalance: {
    type: Number,
    default: 0,
  },
  purchaseHistory: [{
    poId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
    },
    amount: Number,
    date: Date,
  }],
  paymentHistory: [{
    amount: Number,
    date: Date,
    reference: String,
  }],
  totalPurchased: {
    type: Number,
    default: 0,
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

module.exports = mongoose.model('Supplier', supplierSchema);
