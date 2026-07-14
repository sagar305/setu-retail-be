const Invoice = require('../models/Invoice');
const Inventory = require('../models/Inventory');
const Customer = require('../models/Customer');
const Coupon = require('../models/Coupon');
const Product = require('../models/Product');

exports.createInvoice = async (req, res) => {
  try {
    const {
      outlet,
      customer,
      items,
      itemDiscount = 0,
      cartDiscount = 0,
      couponCode,
      rewardPointsRedeemed = 0,
      payment,
    } = req.body;

    // Generate invoice number
    const invoiceNumber = `INV-${Date.now()}`;

    let totalAmount = 0;
    let totalTax = 0;
    let couponDiscount = 0;

    // Calculate totals and update inventory
    const processedItems = [];
    for (const item of items) {
      const product = await Product.findOne({
        _id: item.productId,
        tenantId: req.tenantId,
      });

      if (!product) {
        return res.status(404).json({ message: `Product ${item.productId} not found` });
      }

      const price = product.pricing.sellingPrice;
      const tax = (price * (product.pricing.tax || 0)) / 100;
      const itemTotal = (price * item.quantity) + tax;

      totalAmount += itemTotal;
      totalTax += tax * item.quantity;

      processedItems.push({
        product: item.productId,
        quantity: item.quantity,
        price,
        tax: product.pricing.tax,
        discount: item.discount || 0,
        totalPrice: itemTotal,
      });

      // Reduce inventory for standard products
      if (product.productType === 'standard') {
        const inventory = await Inventory.findOne({
          productId: item.productId,
          tenantId: req.tenantId,
        });

        if (inventory) {
          inventory.currentStock -= item.quantity;
          inventory.movements.push({
            type: 'sale',
            quantity: item.quantity,
            reference: invoiceNumber,
            createdBy: req.user.userId,
          });
          await inventory.save();
        }
      }
    }

    // Validate and apply coupon
    if (couponCode) {
      const coupon = await Coupon.findOne({
        code: couponCode,
        tenantId: req.tenantId,
        isActive: true,
      });

      if (coupon && new Date() <= coupon.endDate) {
        if (coupon.discountType === 'percentage') {
          couponDiscount = (totalAmount * coupon.discountValue) / 100;
          if (coupon.maxDiscount) {
            couponDiscount = Math.min(couponDiscount, coupon.maxDiscount);
          }
        } else {
          couponDiscount = coupon.discountValue;
        }
      }
    }

    // Calculate reward points
    const rewardPointsEarned = Math.floor(totalAmount / 100); // 1 point per ₹100

    // Calculate grand total
    const grandTotal = totalAmount + totalTax - itemDiscount - cartDiscount - couponDiscount - (rewardPointsRedeemed * 50); // Assume 50 points = ₹50

    const invoice = new Invoice({
      tenantId: req.tenantId,
      invoiceNumber,
      outlet,
      customer,
      cashier: req.user.userId,
      items: processedItems,
      subtotal: totalAmount,
      itemDiscount,
      cartDiscount,
      couponCode,
      couponDiscount,
      rewardPointsRedeemed,
      rewardPointsEarned,
      taxAmount: totalTax,
      grandTotal,
      payment,
      status: 'completed',
      isOnline: true,
    });

    await invoice.save();

    // Update customer reward points and purchase history
    if (customer) {
      const cust = await Customer.findOne({
        _id: customer,
        tenantId: req.tenantId,
      });

      if (cust) {
        cust.rewardPoints += rewardPointsEarned - rewardPointsRedeemed;
        cust.purchaseHistory.push({
          invoiceId: invoice._id,
          amount: grandTotal,
          date: new Date(),
        });
        cust.lastPurchaseDate = new Date();
        cust.totalPurchaseValue += grandTotal;
        await cust.save();
      }
    }

    res.status(201).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getInvoices = async (req, res) => {
  try {
    const { outlet, customer, dateFrom, dateTo, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (outlet) filter.outlet = outlet;
    if (customer) filter.customer = customer;
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo);
    }

    const invoices = await Invoice.find(filter)
      .populate('customer', 'name phone')
      .populate('cashier', 'name')
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ invoiceDate: -1 });

    const total = await Invoice.countDocuments(filter);

    res.json({ invoices, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    })
      .populate('customer')
      .populate('cashier', 'name')
      .populate('items.product');

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getSalesReport = async (req, res) => {
  try {
    const { dateFrom, dateTo, outlet } = req.query;
    const filter = { tenantId: req.tenantId, status: 'completed' };

    if (outlet) filter.outlet = outlet;
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo);
    }

    const invoices = await Invoice.find(filter);

    const report = {
      totalInvoices: invoices.length,
      totalRevenue: 0,
      totalTax: 0,
      totalDiscount: 0,
      averageOrderValue: 0,
    };

    invoices.forEach(inv => {
      report.totalRevenue += inv.grandTotal;
      report.totalTax += inv.taxAmount || 0;
      report.totalDiscount += (inv.itemDiscount || 0) + (inv.cartDiscount || 0) + (inv.couponDiscount || 0);
    });

    report.averageOrderValue = report.totalInvoices > 0 ? report.totalRevenue / report.totalInvoices : 0;

    res.json(report);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getTopSellingProducts = async (req, res) => {
  try {
    const { dateFrom, dateTo, limit = 10, outlet } = req.query;
    const filter = { tenantId: req.tenantId, status: 'completed' };

    if (outlet) filter.outlet = outlet;
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo);
    }

    const invoices = await Invoice.find(filter).populate('items.product');

    const productSales = {};
    invoices.forEach(inv => {
      inv.items.forEach(item => {
        const productId = item.product._id.toString();
        if (!productSales[productId]) {
          productSales[productId] = {
            product: item.product,
            quantity: 0,
            revenue: 0,
          };
        }
        productSales[productId].quantity += item.quantity;
        productSales[productId].revenue += item.totalPrice;
      });
    });

    const topProducts = Object.values(productSales)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, parseInt(limit));

    res.json(topProducts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
