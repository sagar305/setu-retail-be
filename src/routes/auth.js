const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Role = require('../models/Role');
const { generateToken } = require('../utils/jwt');

router.post('/signup', async (req, res) => {
  try {
    const { businessName, email, phone, password } = req.body;

    const existingTenant = await Tenant.findOne({ email });
    if (existingTenant) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    const tenant = new Tenant({
      name: email.split('@')[0],
      email,
      phone,
      businessName,
    });
    await tenant.save();

    let adminRole = await Role.findOne({ tenantId: tenant._id, name: 'owner' });
    if (!adminRole) {
      adminRole = await Role.create({
        name: 'owner',
        description: 'Owner role',
        permissions: [],
        tenantId: tenant._id,
        isPreDefined: true,
      });
    }

    const user = new User({
      tenantId: tenant._id,
      name: businessName,
      email,
      phone,
      password,
      role: adminRole._id,
    });
    await user.save();

    const token = generateToken(user._id, tenant._id, 'owner');
    res.status(201).json({ token, user, tenant });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: error.message, stack: error.stack });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).populate('role');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id, user.tenantId, user.role?.name);
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/forgot-password', async (req, res) => {
  // TODO: Implement email OTP for password reset
  res.json({ message: 'Password reset link sent to email' });
});

module.exports = router;
