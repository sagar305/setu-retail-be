const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  sku: {
    type: String,
    required: true,
    unique: true,
  },
  barcode: String,
  productType: {
    type: String,
    enum: ['standard', 'weight_based', 'variable_price', 'service'],
    required: true,
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true,
  },
  subCategory: String,
  brand: String,
  description: String,
  image: String,

  pricing: {
    mrp: {
      type: Number,
      required: true,
    },
    sellingPrice: {
      type: Number,
      required: true,
    },
    purchasePrice: {
      type: Number,
      required: true,
    },
    tax: {
      type: Number,
      default: 0,
    },
    hsnCode: String,
  },

  unit: {
    type: String,
    enum: ['piece', 'box', 'packet', 'bottle', 'kg', 'gram', 'liter', 'ml'],
    required: true,
  },

  inventory: {
    openingStock: Number,
    minimumStock: Number,
    maximumStock: Number,
    reorderLevel: Number,
    warehouse: String,
    shelf: String,
  },

  weightBased: {
    pricePerKg: Number,
    pricePerGram: Number,
    barcodePrefix: String,
    decimalPrecision: {
      type: Number,
      default: 2,
    },
    tareWeight: Number,
    shelfLife: Number,
  },

  variants: [{
    name: String,
    sku: String,
    barcode: String,
    stock: Number,
    price: Number,
  }],

  isFavorite: {
    type: Boolean,
    default: false,
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

module.exports = mongoose.model('Product', productSchema);
