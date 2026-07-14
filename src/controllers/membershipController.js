const Membership = require('../models/Membership');
const Customer = require('../models/Customer');

exports.getMemberships = async (req, res) => {
  try {
    const memberships = await Membership.find({ tenantId: req.tenantId }).sort({ tier: 1 });

    res.json(memberships);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createMembership = async (req, res) => {
  try {
    const { name, tier, minSpendAmount, discountPercentage, benefits, description } = req.body;

    const existing = await Membership.findOne({
      tenantId: req.tenantId,
      tier,
    });

    if (existing) {
      return res.status(400).json({ message: 'Membership tier already exists' });
    }

    const membership = new Membership({
      tenantId: req.tenantId,
      name,
      tier,
      minSpendAmount,
      discountPercentage,
      benefits,
      description,
    });

    await membership.save();
    res.status(201).json(membership);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getMembershipById = async (req, res) => {
  try {
    const membership = await Membership.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!membership) return res.status(404).json({ message: 'Membership not found' });

    res.json(membership);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateMembership = async (req, res) => {
  try {
    const membership = await Membership.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    );

    if (!membership) return res.status(404).json({ message: 'Membership not found' });

    res.json(membership);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getMembershipStats = async (req, res) => {
  try {
    const memberships = await Membership.find({ tenantId: req.tenantId });

    const stats = {
      totalTiers: memberships.length,
      byTier: {},
    };

    for (const membership of memberships) {
      const count = await Customer.countDocuments({
        tenantId: req.tenantId,
        'membership.tier': membership.tier,
      });

      stats.byTier[membership.name] = count;
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPredefinedMemberships = async (req, res) => {
  try {
    const predefined = [
      {
        name: 'New Member',
        tier: 'new',
        minSpendAmount: 0,
        discountPercentage: 0,
        benefits: ['Welcome discount on first purchase'],
      },
      {
        name: 'Regular',
        tier: 'regular',
        minSpendAmount: 5000,
        discountPercentage: 5,
        benefits: ['5% discount on all purchases', 'Double reward points'],
      },
      {
        name: 'VIP',
        tier: 'vip',
        minSpendAmount: 25000,
        discountPercentage: 10,
        benefits: ['10% discount on all purchases', 'Triple reward points', 'Free delivery', 'Priority support'],
      },
    ];

    res.json(predefined);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
