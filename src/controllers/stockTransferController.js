const StockTransfer = require('../models/StockTransfer');
const Inventory = require('../models/Inventory');

const generateTransferNumber = async (tenantId) => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const prefix = `ST-${year}${month}`;

  const count = await StockTransfer.countDocuments({
    tenantId,
    transferNumber: { $regex: `^${prefix}` },
  });

  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
};

exports.getStockTransfers = async (req, res) => {
  try {
    const { status, fromOutlet, toOutlet, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (status) filter.status = status;
    if (fromOutlet) filter.fromOutlet = fromOutlet;
    if (toOutlet) filter.toOutlet = toOutlet;

    const transfers = await StockTransfer.find(filter)
      .populate('fromOutlet', 'name')
      .populate('toOutlet', 'name')
      .populate('items.product', 'name sku')
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ transferDate: -1 });

    const total = await StockTransfer.countDocuments(filter);

    res.json({ transfers, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createStockTransfer = async (req, res) => {
  try {
    const { fromOutlet, toOutlet, items, remarks } = req.body;

    if (fromOutlet === toOutlet) {
      return res.status(400).json({ message: 'Source and destination outlets cannot be the same' });
    }

    const transferNumber = await generateTransferNumber(req.tenantId);

    const transfer = new StockTransfer({
      tenantId: req.tenantId,
      transferNumber,
      fromOutlet,
      toOutlet,
      items,
      remarks,
      requestedBy: req.userId,
      transferDate: new Date(),
    });

    await transfer.save();
    await transfer.populate('fromOutlet', 'name');
    await transfer.populate('toOutlet', 'name');
    await transfer.populate('items.product', 'name sku');

    res.status(201).json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getStockTransferById = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    })
      .populate('fromOutlet')
      .populate('toOutlet')
      .populate('items.product');

    if (!transfer) return res.status(404).json({ message: 'Stock Transfer not found' });

    res.json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateStockTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!transfer) return res.status(404).json({ message: 'Stock Transfer not found' });

    if (transfer.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft transfers can be updated' });
    }

    Object.assign(transfer, req.body);
    await transfer.save();

    res.json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.approveStockTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!transfer) return res.status(404).json({ message: 'Stock Transfer not found' });

    if (transfer.status !== 'requested') {
      return res.status(400).json({ message: 'Only requested transfers can be approved' });
    }

    transfer.status = 'approved';
    transfer.approvedBy = req.userId;
    await transfer.save();

    res.json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.shipStockTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('items.product');

    if (!transfer) return res.status(404).json({ message: 'Stock Transfer not found' });

    if (transfer.status !== 'approved') {
      return res.status(400).json({ message: 'Only approved transfers can be shipped' });
    }

    for (const item of transfer.items) {
      await Inventory.findOneAndUpdate(
        { productId: item.product._id, tenantId: req.tenantId },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'transfer',
              quantity: -item.quantity,
              reference: transfer.transferNumber,
              date: new Date(),
            },
          },
        }
      );
    }

    transfer.status = 'shipped';
    await transfer.save();

    res.json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.receiveStockTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('items.product');

    if (!transfer) return res.status(404).json({ message: 'Stock Transfer not found' });

    if (transfer.status !== 'shipped') {
      return res.status(400).json({ message: 'Only shipped transfers can be received' });
    }

    for (const item of transfer.items) {
      await Inventory.findOneAndUpdate(
        { productId: item.product._id, tenantId: req.tenantId },
        {
          $inc: { currentStock: item.quantity },
          $push: {
            movements: {
              type: 'transfer',
              quantity: item.quantity,
              reference: transfer.transferNumber,
              date: new Date(),
            },
          },
        }
      );
    }

    transfer.status = 'received';
    await transfer.save();

    res.json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.rejectStockTransfer = async (req, res) => {
  try {
    const { remarks } = req.body;

    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!transfer) return res.status(404).json({ message: 'Stock Transfer not found' });

    if (!['requested', 'approved'].includes(transfer.status)) {
      return res.status(400).json({ message: 'Cannot reject transfer in current status' });
    }

    transfer.status = 'rejected';
    transfer.remarks = remarks || transfer.remarks;
    await transfer.save();

    res.json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getStockTransferStats = async (req, res) => {
  try {
    const transfers = await StockTransfer.find({ tenantId: req.tenantId });

    const stats = {
      totalTransfers: transfers.length,
      draftCount: transfers.filter((t) => t.status === 'draft').length,
      requestedCount: transfers.filter((t) => t.status === 'requested').length,
      approvedCount: transfers.filter((t) => t.status === 'approved').length,
      shippedCount: transfers.filter((t) => t.status === 'shipped').length,
      receivedCount: transfers.filter((t) => t.status === 'received').length,
      rejectedCount: transfers.filter((t) => t.status === 'rejected').length,
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
