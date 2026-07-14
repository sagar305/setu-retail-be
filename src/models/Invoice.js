const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  invoiceNumber: {
    type: String,
    required: true,
    unique: true,
  },
  outlet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Outlet',
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
  },
  cashier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    quantity: Number,
    price: Number,
    tax: Number,
    discount: Number,
    totalPrice: Number,
  }],
  subtotal: Number,
  itemDiscount: Number,
  cartDiscount: Number,
  couponCode: String,
  couponDiscount: Number,
  rewardPointsRedeemed: Number,
  rewardPointsEarned: Number,
  membershipDiscount: Number,
  taxAmount: Number,
  grandTotal: Number,
  payment: {
    method: {
      type: String,
      enum: ['cash', 'card', 'upi', 'wallet', 'gift_card', 'store_credit'],
    },
    splitPayments: [{
      method: String,
      amount: Number,
    }],
    change: Number,
  },
  status: {
    type: String,
    enum: ['completed', 'voided', 'refunded'],
    default: 'completed',
  },
  invoiceDate: {
    type: Date,
    default: Date.now,
  },
  notes: String,
  isOnline: {
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

module.exports = mongoose.model('Invoice', invoiceSchema);
