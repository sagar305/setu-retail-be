import express, { Response } from 'express';
import Bill from '../models/Bill';
import Inventory from '../models/Inventory';
import { AuthRequest, authMiddleware, roleMiddleware } from '../middleware/auth';

const router = express.Router();

// Create bill
router.post('/', authMiddleware, roleMiddleware(['cashier', 'owner', 'manager']), async (req: AuthRequest, res: Response) => {
  try {
    const {
      billNumber,
      customerId,
      outlet,
      items,
      subtotal,
      taxAmount,
      discountAmount,
      total,
      paymentMethod,
      paymentDetails,
      notes,
    } = req.body;

    const bill = new Bill({
      tenantId: req.user?.tenantId,
      billNumber,
      customerId,
      cashierId: req.user?.userId,
      outlet,
      items,
      subtotal,
      taxAmount,
      discountAmount,
      total,
      paymentMethod,
      paymentDetails,
      status: 'completed',
      notes,
    });

    await bill.save();

    // Update inventory for each item
    for (const item of items) {
      await Inventory.findOneAndUpdate(
        { tenantId: req.user?.tenantId, productId: item.productId, outlet },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'sale',
              quantity: item.quantity,
              reference: billNumber,
              date: new Date(),
            },
          },
          lastUpdated: new Date(),
        },
        { upsert: true }
      );
    }

    res.status(201).json({ message: 'Bill created', bill });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Get bills
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { startDate, endDate, outlet } = req.query;
    let query: any = { tenantId: req.user?.tenantId };

    if (outlet) {
      query.outlet = outlet;
    }

    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate as string),
        $lte: new Date(endDate as string),
      };
    }

    const bills = await Bill.find(query).sort({ createdAt: -1 }).limit(100);
    res.json(bills);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Get bill by ID
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, tenantId: req.user?.tenantId });

    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }

    res.json(bill);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

export default router;
