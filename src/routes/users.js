const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Role = require('../models/Role');

router.get('/', async (req, res) => {
  try {
    const users = await User.find({ tenantId: req.tenantId }).populate('role outlet');
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { email, name, phone, roleId, role, outlet } = req.body;

    const existing = await User.findOne({ tenantId: req.tenantId, email });
    if (existing) {
      return res.status(400).json({ message: 'An employee with this email already exists' });
    }

    // Accept either a Role id or a role name ("cashier")
    let resolvedRoleId = roleId;
    if (!resolvedRoleId && role) {
      const roleDoc = await Role.findOne({
        tenantId: req.tenantId,
        name: { $regex: `^${role}$`, $options: 'i' },
      });
      resolvedRoleId = roleDoc?._id;
    }

    const tempPassword = Math.random().toString(36).slice(-8);

    const user = new User({
      tenantId: req.tenantId,
      email,
      name,
      phone,
      password: tempPassword,
      role: resolvedRoleId,
      outlet,
    });
    await user.save();
    res.status(201).json({ user, tempPassword });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    ).populate('role outlet');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
