const Supplier = require('../models/Supplier');

exports.getSuppliers = async (req, res) => {
  try {
    const { search, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId, isActive: true };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { gst: { $regex: search, $options: 'i' } },
      ];
    }

    const suppliers = await Supplier.find(filter)
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ name: 1 });

    const total = await Supplier.countDocuments(filter);

    res.json({ suppliers, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createSupplier = async (req, res) => {
  try {
    const { name, phone, email, gst, address } = req.body;

    const existing = await Supplier.findOne({
      tenantId: req.tenantId,
      name: { $regex: `^${name}$`, $options: 'i' },
      isActive: true,
    });

    if (existing) {
      return res.status(400).json({ message: 'Supplier with this name already exists' });
    }

    const supplier = new Supplier({
      tenantId: req.tenantId,
      name,
      phone,
      email,
      gst,
      address,
    });

    await supplier.save();

    res.status(201).json(supplier);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getSupplierById = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('purchaseHistory.poId');

    if (!supplier) return res.status(404).json({ message: 'Supplier not found' });

    res.json(supplier);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    );

    if (!supplier) return res.status(404).json({ message: 'Supplier not found' });

    res.json(supplier);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { isActive: false },
      { new: true }
    );

    if (!supplier) return res.status(404).json({ message: 'Supplier not found' });

    res.json({ message: 'Supplier deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.recordPayment = async (req, res) => {
  try {
    const { amount, reference } = req.body;

    const supplier = await Supplier.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!supplier) return res.status(404).json({ message: 'Supplier not found' });

    supplier.paymentHistory.push({
      amount,
      date: new Date(),
      reference,
    });

    supplier.outstandingBalance = Math.max(0, supplier.outstandingBalance - amount);

    await supplier.save();

    res.json(supplier);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getSupplierStats = async (req, res) => {
  try {
    const suppliers = await Supplier.find({
      tenantId: req.tenantId,
      isActive: true,
    });

    const stats = {
      totalSuppliers: suppliers.length,
      totalOutstanding: 0,
      totalPurchased: 0,
      averagePurchaseValue: 0,
    };

    suppliers.forEach((s) => {
      stats.totalOutstanding += s.outstandingBalance;
      stats.totalPurchased += s.totalPurchased;
    });

    stats.averagePurchaseValue = suppliers.length > 0 ? stats.totalPurchased / suppliers.length : 0;

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
