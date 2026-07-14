const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  outlet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Outlet',
  },
  warehouse: String,
  shelf: String,
  currentStock: {
    type: Number,
    default: 0,
  },
  movements: [{
    type: {
      type: String,
      enum: ['purchase', 'sale', 'return', 'damage', 'adjustment', 'transfer', 'audit'],
    },
    quantity: Number,
    reference: String,
    reason: String,
    date: {
      type: Date,
      default: Date.now,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  }],
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

module.exports = mongoose.model('Inventory', inventorySchema);
