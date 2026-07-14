const mongoose = require('mongoose');

const offerSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  description: String,
  offerType: {
    type: String,
    enum: ['bogo', 'buy_x_get_y', 'percentage_discount', 'flat_discount', 'combo', 'free_product', 'category_discount', 'brand_discount'],
    required: true,
  },
  applicableOn: {
    type: String,
    enum: ['product', 'category', 'brand'],
  },
  productIds: [mongoose.Schema.Types.ObjectId],
  categoryIds: [mongoose.Schema.Types.ObjectId],
  brandIds: [String],
  buyQuantity: Number,
  getQuantity: Number,
  freeProductId: mongoose.Schema.Types.ObjectId,
  discountType: {
    type: String,
    enum: ['flat', 'percentage'],
  },
  discountValue: Number,
  maxDiscount: Number,
  minPurchaseAmount: Number,
  startDate: Date,
  endDate: Date,
  usageLimit: Number,
  usageCount: {
    type: Number,
    default: 0,
  },
  priority: {
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

module.exports = mongoose.model('Offer', offerSchema);
