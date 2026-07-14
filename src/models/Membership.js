const mongoose = require('mongoose');

const membershipSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  tier: {
    type: String,
    enum: ['new', 'silver', 'gold', 'platinum'],
  },
  description: String,
  color: String,
  discountPercentage: {
    type: Number,
    default: 0,
  },
  rewardPointsMultiplier: {
    type: Number,
    default: 1,
  },
  minPurchaseValue: {
    type: Number,
    default: 0,
  },
  timePeriod: {
    type: String,
    enum: ['monthly', 'yearly'],
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

module.exports = mongoose.model('Membership', membershipSchema);
