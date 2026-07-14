const PricingRule = require('../models/PricingRule');

exports.getPricingRules = async (req, res) => {
  try {
    const { active, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (active === 'true') {
      filter.isActive = true;
    }

    const rules = await PricingRule.find(filter)
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ priority: 1, createdAt: -1 });

    const total = await PricingRule.countDocuments(filter);

    res.json({ rules, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createPricingRule = async (req, res) => {
  try {
    const { name, ruleType, applicableProducts, applicableCategories, condition, priceAdjustment, startDate, endDate, priority } = req.body;

    const rule = new PricingRule({
      tenantId: req.tenantId,
      name,
      ruleType,
      applicableProducts,
      applicableCategories,
      condition,
      priceAdjustment,
      startDate,
      endDate,
      priority: priority || 0,
      isActive: true,
    });

    await rule.save();
    res.status(201).json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPricingRuleById = async (req, res) => {
  try {
    const rule = await PricingRule.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('applicableProducts', 'name sku');

    if (!rule) return res.status(404).json({ message: 'Pricing rule not found' });

    res.json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updatePricingRule = async (req, res) => {
  try {
    const rule = await PricingRule.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    );

    if (!rule) return res.status(404).json({ message: 'Pricing rule not found' });

    res.json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deactivatePricingRule = async (req, res) => {
  try {
    const rule = await PricingRule.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { isActive: false },
      { new: true }
    );

    if (!rule) return res.status(404).json({ message: 'Pricing rule not found' });

    res.json(rule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getApplicablePricingRules = async (req, res) => {
  try {
    const { productId, category } = req.query;

    const now = new Date();

    const rules = await PricingRule.find({
      tenantId: req.tenantId,
      isActive: true,
      startDate: { $lte: now },
      $or: [
        { endDate: { $gte: now } },
        { endDate: { $exists: false } },
      ],
      $or: [
        { applicableProducts: productId },
        { applicableCategories: category },
      ],
    }).sort({ priority: 1 });

    res.json(rules);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.calculateAdjustedPrice = async (req, res) => {
  try {
    const { productId, basePrice, category } = req.body;

    const rules = await PricingRule.find({
      tenantId: req.tenantId,
      isActive: true,
      startDate: { $lte: new Date() },
      $or: [
        { endDate: { $gte: new Date() } },
        { endDate: { $exists: false } },
      ],
      $or: [
        { applicableProducts: productId },
        { applicableCategories: category },
      ],
    }).sort({ priority: 1 });

    let adjustedPrice = basePrice;

    for (const rule of rules) {
      if (rule.priceAdjustment.type === 'percentage') {
        adjustedPrice *= (1 + rule.priceAdjustment.value / 100);
      } else if (rule.priceAdjustment.type === 'fixed') {
        adjustedPrice += rule.priceAdjustment.value;
      }
    }

    res.json({
      basePrice,
      adjustedPrice: Math.round(adjustedPrice * 100) / 100,
      appliedRules: rules.map((r) => r.name),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
