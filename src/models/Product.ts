import mongoose, { Schema, Document } from 'mongoose';

export interface IProduct extends Document {
  tenantId: string;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  subCategory?: string;
  brand?: string;
  description?: string;
  image?: string;
  productType: 'standard' | 'weight' | 'variable' | 'service';
  sellingPrice: number;
  purchasePrice: number;
  tax: number;
  hsnCode?: string;
  unit: 'piece' | 'box' | 'packet' | 'bottle' | 'kg' | 'gram' | 'liter' | 'ml';
  openingStock: number;
  minimumStock: number;
  maximumStock: number;
  reorderLevel: number;
  warehouse?: string;
  shelf?: string;
  weightConfig?: {
    pricePerKg: number;
    pricePerGram: number;
    barcodePrefix: string;
    barcodeFormat: string;
    decimalPrecision: number;
    tareWeight: number;
    shelfLife: number;
  };
  variants?: {
    name: string;
    options: string[];
  }[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    sku: { type: String, required: true, unique: true },
    barcode: { type: String, required: true, unique: true },
    category: { type: String, required: true },
    subCategory: { type: String },
    brand: { type: String },
    description: { type: String },
    image: { type: String },
    productType: {
      type: String,
      enum: ['standard', 'weight', 'variable', 'service'],
      required: true,
    },
    sellingPrice: { type: Number, required: true },
    purchasePrice: { type: Number, required: true },
    tax: { type: Number, required: true },
    hsnCode: { type: String },
    unit: {
      type: String,
      enum: ['piece', 'box', 'packet', 'bottle', 'kg', 'gram', 'liter', 'ml'],
      required: true,
    },
    openingStock: { type: Number, default: 0 },
    minimumStock: { type: Number, default: 10 },
    maximumStock: { type: Number, default: 1000 },
    reorderLevel: { type: Number, default: 50 },
    warehouse: { type: String },
    shelf: { type: String },
    weightConfig: {
      pricePerKg: { type: Number },
      pricePerGram: { type: Number },
      barcodePrefix: { type: String },
      barcodeFormat: { type: String },
      decimalPrecision: { type: Number },
      tareWeight: { type: Number },
      shelfLife: { type: Number },
    },
    variants: [
      {
        name: { type: String },
        options: [{ type: String }],
      },
    ],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ tenantId: 1, barcode: 1 });
productSchema.index({ tenantId: 1, sku: 1 });
productSchema.index({ tenantId: 1, name: 1 });

export default mongoose.model<IProduct>('Product', productSchema);
