const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  code: {
    type: String,
    required: true,
    unique: true,
  },
  description: String,
  discountType: {
    type: String,
    enum: ['flat', 'percentage'],
    required: true,
  },
  discountValue: {
    type: Number,
    required: true,
  },
  maxDiscount: Number,
  minPurchaseAmount: Number,
  maxUsage: Number,
  usageCount: {
    type: Number,
    default: 0,
  },
  usagePerCustomer: {
    type: Number,
    default: 1,
  },
  isSingleUse: {
    type: Boolean,
    default: false,
  },
  startDate: Date,
  endDate: Date,
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

module.exports = mongoose.model('Coupon', couponSchema);
