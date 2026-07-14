const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  returnNumber: {
    type: String,
    required: true,
    unique: true,
  },
  invoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    quantity: Number,
    weight: Number,
    price: Number,
  }],
  returnType: {
    type: String,
    enum: ['partial', 'full', 'exchange'],
  },
  refundMode: {
    type: String,
    enum: ['cash', 'card', 'wallet', 'store_credit'],
  },
  refundAmount: Number,
  storeCredit: Number,
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  reason: String,
  returnDate: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

module.exports = mongoose.model('Return', returnSchema);
