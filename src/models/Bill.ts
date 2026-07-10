import mongoose, { Schema, Document } from 'mongoose';

export interface IBillItem {
  productId: string;
  productName: string;
  quantity: number;
  weight?: number;
  price: number;
  tax: number;
  discount: number;
  total: number;
  barcode: string;
}

export interface IBill extends Document {
  tenantId: string;
  billNumber: string;
  customerId?: string;
  cashierId: string;
  outlet: string;
  items: IBillItem[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  paymentMethod: 'cash' | 'card' | 'upi' | 'wallet' | 'credit' | 'split';
  paymentDetails?: any;
  status: 'pending' | 'completed' | 'voided' | 'returned';
  holdBillNumber?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const billItemSchema = new Schema<IBillItem>({
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  quantity: { type: Number, required: true },
  weight: { type: Number },
  price: { type: Number, required: true },
  tax: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  total: { type: Number, required: true },
  barcode: { type: String, required: true },
});

const billSchema = new Schema<IBill>(
  {
    tenantId: { type: String, required: true, index: true },
    billNumber: { type: String, required: true, unique: true },
    customerId: { type: String },
    cashierId: { type: String, required: true },
    outlet: { type: String, required: true },
    items: [billItemSchema],
    subtotal: { type: Number, required: true },
    taxAmount: { type: Number, required: true },
    discountAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'upi', 'wallet', 'credit', 'split'],
      required: true,
    },
    paymentDetails: { type: Schema.Types.Mixed },
    status: {
      type: String,
      enum: ['pending', 'completed', 'voided', 'returned'],
      default: 'completed',
    },
    holdBillNumber: { type: String },
    notes: { type: String },
  },
  { timestamps: true }
);

billSchema.index({ tenantId: 1, createdAt: -1 });
billSchema.index({ tenantId: 1, customerId: 1 });
billSchema.index({ tenantId: 1, billNumber: 1 });

export default mongoose.model<IBill>('Bill', billSchema);
