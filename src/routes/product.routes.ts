import express, { Response } from 'express';
import Product from '../models/Product';
import { AuthRequest, authMiddleware, roleMiddleware } from '../middleware/auth';

const router = express.Router();

// Get all products
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { search, category } = req.query;
    let query: any = { tenantId: req.user?.tenantId };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } },
      ];
    }

    if (category) {
      query.category = category;
    }

    const products = await Product.find(query).limit(50);
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Get product by barcode or SKU
router.get('/scan/:barcode', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const product = await Product.findOne({
      tenantId: req.user?.tenantId,
      $or: [{ barcode: req.params.barcode }, { sku: req.params.barcode }],
    });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Create product
router.post('/', authMiddleware, roleMiddleware(['owner', 'manager']), async (req: AuthRequest, res: Response) => {
  try {
    const { name, sku, barcode, category, sellingPrice, purchasePrice, tax, unit, productType } = req.body;

    const existingProduct = await Product.findOne({
      tenantId: req.user?.tenantId,
      $or: [{ sku }, { barcode }],
    });

    if (existingProduct) {
      return res.status(409).json({ message: 'SKU or Barcode already exists' });
    }

    const product = new Product({
      tenantId: req.user?.tenantId,
      name,
      sku,
      barcode,
      category,
      sellingPrice,
      purchasePrice,
      tax,
      unit,
      productType,
      ...req.body,
    });

    await product.save();
    res.status(201).json({ message: 'Product created', product });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Update product
router.put('/:id', authMiddleware, roleMiddleware(['owner', 'manager']), async (req: AuthRequest, res: Response) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.user?.tenantId },
      req.body,
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ message: 'Product updated', product });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

export default router;
