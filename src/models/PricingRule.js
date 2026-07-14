const mongoose = require('mongoose');

const pricingRuleSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  ruleType: {
    type: String,
    enum: ['mrp', 'selling_price', 'offer_price', 'happy_hours', 'weekend_price', 'festival_price', 'membership_price'],
    required: true,
  },
  applicableOn: {
    type: String,
    enum: ['product', 'category', 'brand'],
  },
  productIds: [mongoose.Schema.Types.ObjectId],
  categoryIds: [mongoose.Schema.Types.ObjectId],
  brandIds: [String],
  price: Number,
  discountType: {
    type: String,
    enum: ['flat', 'percentage'],
  },
  discountValue: Number,
  startDate: Date,
  endDate: Date,
  dayOfWeek: [Number],
  timeFrom: String,
  timeTo: String,
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

module.exports = mongoose.model('PricingRule', pricingRuleSchema);
