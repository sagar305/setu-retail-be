const express = require('express');
const router = express.Router();
const Outlet = require('../models/Outlet');

router.get('/', async (req, res) => {
  try {
    const { tenantId } = req;
    const outlets = await Outlet.find({ tenantId, isActive: true }).sort({ createdAt: -1 });
    res.json(outlets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const outlet = await Outlet.findById(req.params.id);
    if (!outlet) return res.status(404).json({ message: 'Outlet not found' });
    res.json(outlet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, address, city, phone, manager, managerId } = req.body;
    const outlet = new Outlet({
      tenantId: req.tenantId,
      name,
      address,
      city,
      phone,
      manager,
      managerId,
      isActive: true,
    });
    await outlet.save();
    res.status(201).json(outlet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, address, city, phone, manager, managerId, isActive } = req.body;
    const outlet = await Outlet.findByIdAndUpdate(
      req.params.id,
      { name, address, city, phone, manager, managerId, isActive },
      { new: true }
    );
    res.json(outlet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Outlet.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ message: 'Outlet deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
