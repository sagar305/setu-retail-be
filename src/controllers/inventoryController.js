const Inventory = require('../models/Inventory');
const Product = require('../models/Product');

exports.getInventory = async (req, res) => {
  try {
    const { outlet, warehouse, lowStockOnly = false, search } = req.query;
    const filter = { tenantId: req.tenantId };

    if (outlet) filter.outlet = outlet;
    if (warehouse) filter.warehouse = warehouse;
    if (search) {
      const products = await Product.find({
        tenantId: req.tenantId,
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { sku: { $regex: search, $options: 'i' } },
        ],
      });
      filter.productId = { $in: products.map(p => p._id) };
    }

    const inventory = await Inventory.find(filter)
      .populate('productId')
      .sort({ updatedAt: -1 });

    if (lowStockOnly) {
      return res.json(
        inventory.filter(inv => {
          const product = inv.productId;
          return product && inv.currentStock <= (product.inventory?.minimumStock || 0);
        })
      );
    }

    res.json(inventory);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getInventoryStats = async (req, res) => {
  try {
    const inventory = await Inventory.find({ tenantId: req.tenantId })
      .populate('productId');

    const stats = {
      totalSkus: await Product.countDocuments({ tenantId: req.tenantId, isActive: true }),
      lowStockCount: 0,
      outOfStockCount: 0,
      totalStockValue: 0,
    };

    inventory.forEach(inv => {
      const product = inv.productId;
      if (!product) return;

      const minStock = product.inventory?.minimumStock || 0;
      if (inv.currentStock <= minStock && inv.currentStock > 0) {
        stats.lowStockCount++;
      }
      if (inv.currentStock === 0) {
        stats.outOfStockCount++;
      }

      stats.totalStockValue += inv.currentStock * (product.pricing?.sellingPrice || 0);
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.adjustStock = async (req, res) => {
  try {
    const { productId, quantity, type, reason } = req.body;

    if (!['purchase', 'sale', 'return', 'damage', 'adjustment', 'transfer', 'audit'].includes(type)) {
      return res.status(400).json({ message: 'Invalid movement type' });
    }

    let inventory = await Inventory.findOne({
      productId,
      tenantId: req.tenantId,
    });

    if (!inventory) {
      inventory = new Inventory({
        tenantId: req.tenantId,
        productId,
        currentStock: 0,
      });
    }

    // Calculate new stock based on movement type
    let newStock = inventory.currentStock;
    if (['purchase', 'return', 'transfer'].includes(type)) {
      newStock += quantity;
    } else if (['sale', 'damage', 'adjustment'].includes(type)) {
      newStock -= quantity;
    } else if (type === 'audit') {
      newStock = quantity; // Audit sets exact stock
    }

    if (newStock < 0) {
      return res.status(400).json({ message: 'Insufficient stock' });
    }

    inventory.currentStock = newStock;
    inventory.movements.push({
      type,
      quantity,
      reason,
      createdBy: req.user.userId,
    });

    await inventory.save();

    res.json(inventory);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getMovementHistory = async (req, res) => {
  try {
    const { productId, skip = 0, limit = 50 } = req.query;

    const inventory = await Inventory.findOne({
      productId,
      tenantId: req.tenantId,
    }).populate('movements.createdBy', 'name');

    if (!inventory) {
      return res.status(404).json({ message: 'Inventory not found' });
    }

    const movements = inventory.movements
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(parseInt(skip), parseInt(skip) + parseInt(limit));

    res.json({
      movements,
      total: inventory.movements.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getProductStock = async (req, res) => {
  try {
    const { productId, outlet } = req.query;

    const filter = {
      productId,
      tenantId: req.tenantId,
    };

    if (outlet) filter.outlet = outlet;

    const inventory = await Inventory.findOne(filter).populate('productId');

    if (!inventory) {
      return res.status(404).json({ message: 'Stock not found' });
    }

    res.json({
      productId: inventory.productId._id,
      currentStock: inventory.currentStock,
      warehouse: inventory.warehouse,
      shelf: inventory.shelf,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
