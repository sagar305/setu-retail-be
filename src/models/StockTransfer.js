const mongoose = require('mongoose');

const stockTransferSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  transferNumber: {
    type: String,
    required: true,
    unique: true,
  },
  fromOutlet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Outlet',
    required: true,
  },
  toOutlet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Outlet',
    required: true,
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    quantity: Number,
  }],
  status: {
    type: String,
    enum: ['draft', 'requested', 'approved', 'shipped', 'received', 'rejected'],
    default: 'draft',
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  remarks: String,
  transferDate: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

module.exports = mongoose.model('StockTransfer', stockTransferSchema);
