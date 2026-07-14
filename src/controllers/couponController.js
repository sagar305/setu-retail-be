const Coupon = require('../models/Coupon');

exports.getCoupons = async (req, res) => {
  try {
    const { active, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (active === 'true') {
      filter.isActive = true;
      filter.expiryDate = { $gte: new Date() };
    }

    const coupons = await Coupon.find(filter)
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Coupon.countDocuments(filter);

    res.json({ coupons, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createCoupon = async (req, res) => {
  try {
    const { code, discountType, discountValue, minPurchaseAmount, maxUsagePerCustomer, expiryDate, description } = req.body;

    const existing = await Coupon.findOne({
      tenantId: req.tenantId,
      code: { $regex: `^${code}$`, $options: 'i' },
    });

    if (existing) {
      return res.status(400).json({ message: 'Coupon code already exists' });
    }

    const coupon = new Coupon({
      tenantId: req.tenantId,
      code,
      discountType,
      discountValue,
      minPurchaseAmount,
      maxUsagePerCustomer,
      expiryDate,
      description,
      isActive: true,
    });

    await coupon.save();
    res.status(201).json(coupon);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.validateCoupon = async (req, res) => {
  try {
    const { code, purchaseAmount, customerId } = req.body;

    const coupon = await Coupon.findOne({
      tenantId: req.tenantId,
      code: { $regex: `^${code}$`, $options: 'i' },
      isActive: true,
      expiryDate: { $gte: new Date() },
    });

    if (!coupon) {
      return res.status(404).json({ message: 'Invalid or expired coupon' });
    }

    if (purchaseAmount < (coupon.minPurchaseAmount || 0)) {
      return res.status(400).json({ message: `Minimum purchase amount is ₹${coupon.minPurchaseAmount}` });
    }

    let discount = 0;
    if (coupon.discountType === 'percentage') {
      discount = (purchaseAmount * coupon.discountValue) / 100;
    } else if (coupon.discountType === 'fixed') {
      discount = coupon.discountValue;
    }

    coupon.usageCount = (coupon.usageCount || 0) + 1;
    await coupon.save();

    res.json({
      valid: true,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    );

    if (!coupon) return res.status(404).json({ message: 'Coupon not found' });

    res.json(coupon);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getCouponById = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!coupon) return res.status(404).json({ message: 'Coupon not found' });

    res.json(coupon);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deactivateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { isActive: false },
      { new: true }
    );

    if (!coupon) return res.status(404).json({ message: 'Coupon not found' });

    res.json(coupon);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
