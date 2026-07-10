import express, { Response } from 'express';
import Inventory from '../models/Inventory';
import { AuthRequest, authMiddleware, roleMiddleware } from '../middleware/auth';

const router = express.Router();

// Get inventory
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { outlet } = req.query;
    let query: any = { tenantId: req.user?.tenantId };

    if (outlet) {
      query.outlet = outlet;
    }

    const inventory = await Inventory.find(query);
    res.json(inventory);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Get low stock items
router.get('/low-stock/:outlet', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const inventory = await Inventory.aggregate([
      {
        $match: {
          tenantId: req.user?.tenantId,
          outlet: req.params.outlet,
        },
      },
      {
        $lookup: {
          from: 'products',
          localField: 'productId',
          foreignField: '_id',
          as: 'product',
        },
      },
      {
        $match: {
          $expr: { $lt: ['$currentStock', { $arrayElemAt: ['$product.minimumStock', 0] }] },
        },
      },
    ]);

    res.json(inventory);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Adjust stock
router.post('/adjust', authMiddleware, roleMiddleware(['owner', 'manager', 'inventory']), async (req: AuthRequest, res: Response) => {
  try {
    const { productId, outlet, quantity, type, reference } = req.body;

    const inventory = await Inventory.findOneAndUpdate(
      { tenantId: req.user?.tenantId, productId, outlet },
      {
        $inc: { currentStock: quantity },
        $push: {
          movements: {
            type,
            quantity: Math.abs(quantity),
            reference,
            date: new Date(),
          },
        },
        lastUpdated: new Date(),
      },
      { new: true, upsert: true }
    );

    res.json({ message: 'Stock adjusted', inventory });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

export default router;
