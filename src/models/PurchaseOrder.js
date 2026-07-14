const mongoose = require('mongoose');

const purchaseOrderSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  poNumber: {
    type: String,
    required: true,
    unique: true,
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
  },
  outlet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Outlet',
  },
  status: {
    type: String,
    enum: ['draft', 'confirmed', 'received', 'invoiced', 'cancelled'],
    default: 'draft',
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    quantity: Number,
    unitPrice: Number,
    tax: Number,
    totalPrice: Number,
    receivedQuantity: {
      type: Number,
      default: 0,
    },
  }],
  totalAmount: Number,
  taxAmount: Number,
  grandTotal: Number,
  poDate: Date,
  expectedDeliveryDate: Date,
  actualDeliveryDate: Date,
  notes: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
