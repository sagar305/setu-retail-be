import mongoose, { Schema, Document } from 'mongoose';

export interface IInventory extends Document {
  tenantId: string;
  productId: string;
  outlet: string;
  currentStock: number;
  lastUpdated: Date;
  movements: {
    type: 'purchase' | 'sale' | 'return' | 'damage' | 'adjustment' | 'transfer';
    quantity: number;
    reference?: string;
    date: Date;
  }[];
}

const movementSchema = new Schema({
  type: { type: String, enum: ['purchase', 'sale', 'return', 'damage', 'adjustment', 'transfer'] },
  quantity: { type: Number, required: true },
  reference: { type: String },
  date: { type: Date, default: Date.now },
});

const inventorySchema = new Schema<IInventory>(
  {
    tenantId: { type: String, required: true, index: true },
    productId: { type: String, required: true },
    outlet: { type: String, required: true },
    currentStock: { type: Number, default: 0 },
    lastUpdated: { type: Date, default: Date.now },
    movements: [movementSchema],
  },
  { timestamps: true }
);

inventorySchema.index({ tenantId: 1, productId: 1, outlet: 1 });

export default mongoose.model<IInventory>('Inventory', inventorySchema);
