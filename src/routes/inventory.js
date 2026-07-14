const express = require('express');
const router = express.Router();
const Inventory = require('../models/Inventory');

router.get('/', async (req, res) => {
  try {
    const inventory = await Inventory.find({ tenantId: req.tenantId }).populate('productId');
    res.json(inventory);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:productId/adjust', async (req, res) => {
  try {
    const { quantity, type, reason } = req.body;
    const inventory = await Inventory.findOne({
      productId: req.params.productId,
      tenantId: req.tenantId,
    });

    if (!inventory) return res.status(404).json({ message: 'Inventory not found' });

    inventory.movements.push({
      type,
      quantity,
      reason,
      createdBy: req.user.userId,
    });

    if (type === 'purchase' || type === 'transfer') {
      inventory.currentStock += quantity;
    } else if (type === 'sale' || type === 'damage' || type === 'adjustment') {
      inventory.currentStock -= quantity;
    }

    await inventory.save();
    res.json(inventory);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
