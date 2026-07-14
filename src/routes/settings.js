const express = require('express');
const router = express.Router();
const Tenant = require('../models/Tenant');

router.get('/', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    res.json(tenant.settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/', async (req, res) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(
      req.tenantId,
      { settings: req.body },
      { new: true }
    );
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    res.json(tenant.settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
