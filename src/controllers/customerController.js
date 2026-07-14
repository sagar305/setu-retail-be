const Customer = require('../models/Customer');
const Membership = require('../models/Membership');

exports.getCustomers = async (req, res) => {
  try {
    const { search, membership, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId, isActive: true };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    if (membership) {
      filter['membership.type'] = membership;
    }

    const customers = await Customer.find(filter)
      .populate('membership.type')
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ lastPurchaseDate: -1 });

    const total = await Customer.countDocuments(filter);

    res.json({ customers, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.searchCustomerByPhone = async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({ message: 'Phone number required' });
    }

    const customers = await Customer.find({
      tenantId: req.tenantId,
      phone: { $regex: phone, $options: 'i' },
      isActive: true,
    })
      .populate('membership.type')
      .limit(10);

    res.json(customers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createCustomer = async (req, res) => {
  try {
    const { name, phone, email, birthday } = req.body;

    // Check if customer with same phone exists
    const existing = await Customer.findOne({
      phone,
      tenantId: req.tenantId,
    });

    if (existing) {
      return res.status(400).json({ message: 'Customer with this phone number already exists' });
    }

    const customer = new Customer({
      tenantId: req.tenantId,
      name,
      phone,
      email,
      birthday,
      membership: {
        tier: 'new',
        joinDate: new Date(),
      },
    });

    await customer.save();

    res.status(201).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('membership.type', 'name tier discountPercentage');

    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    ).populate('membership.type');

    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addRewardPoints = async (req, res) => {
  try {
    const { points, reason } = req.body;

    const customer = await Customer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    customer.rewardPoints += points;
    if (customer.rewardPoints < 0) customer.rewardPoints = 0;

    await customer.save();

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addStoreCredit = async (req, res) => {
  try {
    const { amount, reason } = req.body;

    const customer = await Customer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    customer.creditBalance += amount;
    if (customer.creditBalance < 0) customer.creditBalance = 0;

    await customer.save();

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPurchaseHistory = async (req, res) => {
  try {
    const { skip = 0, limit = 50 } = req.query;

    const customer = await Customer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate({
      path: 'purchaseHistory.invoiceId',
      model: 'Invoice',
    });

    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    const history = customer.purchaseHistory
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(parseInt(skip), parseInt(skip) + parseInt(limit));

    res.json({
      history,
      total: customer.purchaseHistory.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateMembership = async (req, res) => {
  try {
    const { membershipType, tier } = req.body;

    const customer = await Customer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    customer.membership.type = membershipType;
    customer.membership.tier = tier;
    await customer.save();

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getCustomerStats = async (req, res) => {
  try {
    const customers = await Customer.find({
      tenantId: req.tenantId,
      isActive: true,
    });

    const stats = {
      totalCustomers: customers.length,
      totalRewardPoints: 0,
      totalStoreCredit: 0,
      totalPurchaseValue: 0,
      averagePurchaseValue: 0,
    };

    customers.forEach(c => {
      stats.totalRewardPoints += c.rewardPoints;
      stats.totalStoreCredit += c.creditBalance;
      stats.totalPurchaseValue += c.totalPurchaseValue;
    });

    stats.averagePurchaseValue = stats.totalCustomers > 0 ? stats.totalPurchaseValue / stats.totalCustomers : 0;

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
