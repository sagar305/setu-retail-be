const Return = require('../models/Return');
const Invoice = require('../models/Invoice');
const Inventory = require('../models/Inventory');
const Customer = require('../models/Customer');

const generateReturnNumber = async (tenantId) => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const prefix = `RET-${year}${month}`;

  const count = await Return.countDocuments({
    tenantId,
    returnNumber: { $regex: `^${prefix}` },
  });

  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
};

exports.getReturns = async (req, res) => {
  try {
    const { status, customerId, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (status) filter.status = status;
    if (customerId) filter.customer = customerId;

    const returns = await Return.find(filter)
      .populate('customer', 'name phone')
      .populate('invoice', 'invoiceNumber')
      .populate('items.product', 'name sku')
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ returnDate: -1 });

    const total = await Return.countDocuments(filter);

    res.json({ returns, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createReturn = async (req, res) => {
  try {
    const { invoiceId, customerId, items, returnType, refundMode, reason } = req.body;

    let refundAmount = 0;
    let storeCredit = 0;

    items.forEach((item) => {
      refundAmount += (item.price || 0) * item.quantity;
    });

    if (refundMode === 'store_credit') {
      storeCredit = refundAmount;
      refundAmount = 0;
    }

    const returnNumber = await generateReturnNumber(req.tenantId);

    const ret = new Return({
      tenantId: req.tenantId,
      returnNumber,
      invoice: invoiceId,
      customer: customerId,
      items,
      returnType,
      refundMode,
      refundAmount,
      storeCredit,
      reason,
      returnDate: new Date(),
      status: 'pending',
    });

    await ret.save();
    await ret.populate('customer', 'name phone');
    await ret.populate('invoice', 'invoiceNumber');
    await ret.populate('items.product', 'name sku');

    res.status(201).json(ret);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getReturnById = async (req, res) => {
  try {
    const ret = await Return.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    })
      .populate('customer')
      .populate('invoice')
      .populate('items.product')
      .populate('approvedBy', 'name');

    if (!ret) return res.status(404).json({ message: 'Return not found' });

    res.json(ret);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.approveReturn = async (req, res) => {
  try {
    const ret = await Return.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('items.product');

    if (!ret) return res.status(404).json({ message: 'Return not found' });

    if (ret.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending returns can be approved' });
    }

    ret.status = 'approved';
    ret.approvedBy = req.userId;

    for (const item of ret.items) {
      await Inventory.findOneAndUpdate(
        { productId: item.product._id, tenantId: req.tenantId },
        {
          $inc: { currentStock: item.quantity },
          $push: {
            movements: {
              type: 'return',
              quantity: item.quantity,
              reference: ret.returnNumber,
              date: new Date(),
            },
          },
        }
      );
    }

    if (ret.storeCredit > 0) {
      await Customer.findByIdAndUpdate(req.params.customerId, {
        $inc: { creditBalance: ret.storeCredit },
      });
    }

    await ret.save();

    res.json(ret);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.rejectReturn = async (req, res) => {
  try {
    const ret = await Return.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!ret) return res.status(404).json({ message: 'Return not found' });

    if (ret.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending returns can be rejected' });
    }

    ret.status = 'rejected';
    ret.approvedBy = req.userId;
    await ret.save();

    res.json(ret);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getReturnStats = async (req, res) => {
  try {
    const returns = await Return.find({ tenantId: req.tenantId });

    const stats = {
      totalReturns: returns.length,
      pendingCount: returns.filter((r) => r.status === 'pending').length,
      approvedCount: returns.filter((r) => r.status === 'approved').length,
      totalRefunded: returns
        .filter((r) => r.status === 'approved')
        .reduce((sum, r) => sum + (r.refundAmount || 0), 0),
      totalStoreCredit: returns
        .filter((r) => r.status === 'approved')
        .reduce((sum, r) => sum + (r.storeCredit || 0), 0),
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
