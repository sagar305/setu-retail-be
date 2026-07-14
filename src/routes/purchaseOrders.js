const express = require('express');
const router = express.Router();
const PurchaseOrder = require('../models/PurchaseOrder');

router.get('/', async (req, res) => {
  try {
    const pos = await PurchaseOrder.find({ tenantId: req.tenantId }).populate('supplier');
    res.json(pos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const poNumber = `PO-${Date.now()}`;
    const po = new PurchaseOrder({
      tenantId: req.tenantId,
      poNumber,
      createdBy: req.user.userId,
      ...req.body,
    });
    await po.save();
    res.status(201).json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const po = await PurchaseOrder.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { status },
      { new: true }
    );
    if (!po) return res.status(404).json({ message: 'PO not found' });
    res.json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
