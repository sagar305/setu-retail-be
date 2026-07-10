import mongoose, { Schema, Document } from 'mongoose';

export interface ICustomer extends Document {
  tenantId: string;
  name: string;
  phone: string;
  email?: string;
  gst?: string;
  rewardPoints: number;
  creditBalance: number;
  purchaseHistory: string[];
  birthday?: Date;
  membership?: {
    type: string;
    expiryDate: Date;
    discount: number;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<ICustomer>(
  {
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    gst: { type: String },
    rewardPoints: { type: Number, default: 0 },
    creditBalance: { type: Number, default: 0 },
    purchaseHistory: [{ type: String }],
    birthday: { type: Date },
    membership: {
      type: { type: String },
      expiryDate: { type: Date },
      discount: { type: Number },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

customerSchema.index({ tenantId: 1, phone: 1 });
customerSchema.index({ tenantId: 1, name: 1 });

export default mongoose.model<ICustomer>('Customer', customerSchema);
