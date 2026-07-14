const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const Inventory = require('../models/Inventory');

const generatePONumber = async (tenantId) => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const prefix = `PO-${year}${month}`;

  const count = await PurchaseOrder.countDocuments({
    tenantId,
    poNumber: { $regex: `^${prefix}` },
  });

  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
};

exports.getPurchaseOrders = async (req, res) => {
  try {
    const { status, supplierId, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (status) filter.status = status;
    if (supplierId) filter.supplier = supplierId;

    const orders = await PurchaseOrder.find(filter)
      .populate('supplier', 'name')
      .populate('items.product', 'name sku')
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ poDate: -1 });

    const total = await PurchaseOrder.countDocuments(filter);

    res.json({ orders, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplier, items, poDate, expectedDeliveryDate, notes } = req.body;

    const poNumber = await generatePONumber(req.tenantId);

    let totalAmount = 0;
    let taxAmount = 0;

    const processedItems = items.map((item) => {
      const itemTax = (item.unitPrice * item.quantity * (item.tax || 0)) / 100;
      const itemTotal = item.unitPrice * item.quantity + itemTax;
      totalAmount += item.unitPrice * item.quantity;
      taxAmount += itemTax;
      return {
        ...item,
        totalPrice: itemTotal,
      };
    });

    const po = new PurchaseOrder({
      tenantId: req.tenantId,
      poNumber,
      supplier,
      items: processedItems,
      totalAmount,
      taxAmount,
      grandTotal: totalAmount + taxAmount,
      poDate: poDate || new Date(),
      expectedDeliveryDate,
      notes,
      createdBy: req.userId,
    });

    await po.save();
    await po.populate('supplier', 'name');
    await po.populate('items.product', 'name sku');

    res.status(201).json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPurchaseOrderById = async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    })
      .populate('supplier')
      .populate('items.product');

    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });

    res.json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updatePurchaseOrder = async (req, res) => {
  try {
    const { items, status, ...updateData } = req.body;

    const po = await PurchaseOrder.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });

    if (po.status !== 'draft' && status && status !== po.status) {
      return res.status(400).json({ message: 'Cannot change status of non-draft PO' });
    }

    if (items) {
      let totalAmount = 0;
      let taxAmount = 0;

      po.items = items.map((item) => {
        const itemTax = (item.unitPrice * item.quantity * (item.tax || 0)) / 100;
        const itemTotal = item.unitPrice * item.quantity + itemTax;
        totalAmount += item.unitPrice * item.quantity;
        taxAmount += itemTax;
        return {
          ...item,
          totalPrice: itemTotal,
        };
      });

      po.totalAmount = totalAmount;
      po.taxAmount = taxAmount;
      po.grandTotal = totalAmount + taxAmount;
    }

    Object.assign(po, updateData);
    if (status) po.status = status;

    await po.save();
    await po.populate('supplier', 'name');
    await po.populate('items.product', 'name sku');

    res.json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.confirmPurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });

    if (po.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft POs can be confirmed' });
    }

    po.status = 'confirmed';
    await po.save();

    res.json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.receivePurchaseOrder = async (req, res) => {
  try {
    const { receivedItems } = req.body;

    const po = await PurchaseOrder.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('items.product');

    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });

    if (po.status !== 'confirmed') {
      return res.status(400).json({ message: 'Only confirmed POs can be received' });
    }

    for (const receivedItem of receivedItems) {
      const item = po.items.find((i) => i._id.toString() === receivedItem.itemId);
      if (item) {
        item.receivedQuantity = receivedItem.quantity;

        await Inventory.findOneAndUpdate(
          { productId: item.product._id, tenantId: req.tenantId },
          {
            $inc: { currentStock: receivedItem.quantity },
            $push: {
              movements: {
                type: 'purchase',
                quantity: receivedItem.quantity,
                reference: po.poNumber,
                date: new Date(),
              },
            },
          },
          { new: true }
        );
      }
    }

    po.status = 'received';
    po.actualDeliveryDate = new Date();
    await po.save();

    res.json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.cancelPurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });

    if (['invoiced', 'cancelled'].includes(po.status)) {
      return res.status(400).json({ message: `Cannot cancel ${po.status} PO` });
    }

    po.status = 'cancelled';
    await po.save();

    res.json(po);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPurchaseOrderStats = async (req, res) => {
  try {
    const orders = await PurchaseOrder.find({ tenantId: req.tenantId });

    const stats = {
      totalOrders: orders.length,
      draftCount: orders.filter((o) => o.status === 'draft').length,
      confirmedCount: orders.filter((o) => o.status === 'confirmed').length,
      receivedCount: orders.filter((o) => o.status === 'received').length,
      totalPurchaseValue: orders.reduce((sum, o) => sum + (o.grandTotal || 0), 0),
      averageOrderValue: 0,
    };

    stats.averageOrderValue = stats.totalOrders > 0 ? stats.totalPurchaseValue / stats.totalOrders : 0;

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
