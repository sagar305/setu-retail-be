const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  name: String,
  phone: {
    type: String,
    required: true,
  },
  email: String,
  gst: String,
  birthday: Date,
  membership: {
    type: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Membership',
    },
    joinDate: Date,
    tier: {
      type: String,
      enum: ['new', 'silver', 'gold'],
      default: 'new',
    },
  },
  rewardPoints: {
    type: Number,
    default: 0,
  },
  creditBalance: {
    type: Number,
    default: 0,
  },
  purchaseHistory: [{
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
    },
    amount: Number,
    date: Date,
  }],
  lastPurchaseDate: Date,
  totalPurchaseValue: {
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

module.exports = mongoose.model('Customer', customerSchema);
