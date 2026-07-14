const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const { v4: uuidv4 } = require('uuid');

exports.getAllProducts = async (req, res) => {
  try {
    const { type, category, isFavorite, search, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId, isActive: true };

    if (type && type !== 'all') filter.productType = type;
    if (category) filter.category = category;
    if (isFavorite === 'true') filter.isFavorite = true;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } },
      ];
    }

    const products = await Product.find(filter)
      .populate('category')
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Product.countDocuments(filter);

    res.json({ products, total, skip: parseInt(skip), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createProduct = async (req, res) => {
  try {
    const { name, productType, category, pricing, unit, variants, image } = req.body;

    // Generate SKU if not provided
    let sku = req.body.sku;
    if (!sku) {
      const prefix = productType.substring(0, 3).toUpperCase();
      const timestamp = Date.now().toString().slice(-6);
      sku = `${prefix}-${timestamp}`;
    }

    // Validate SKU uniqueness
    const existingSku = await Product.findOne({ sku, tenantId: req.tenantId });
    if (existingSku) {
      return res.status(400).json({ message: 'SKU already exists' });
    }

    // Generate barcode if weight-based product
    let barcode = req.body.barcode;
    if (productType === 'weight_based' && !barcode) {
      barcode = `WB-${Date.now()}`;
    }

    const product = new Product({
      tenantId: req.tenantId,
      name,
      sku,
      barcode,
      productType,
      category,
      pricing,
      unit,
      variants: variants || [],
      image,
    });

    await product.save();

    // Create inventory record for standard products
    if (productType === 'standard') {
      const inventory = new Inventory({
        tenantId: req.tenantId,
        productId: product._id,
        currentStock: pricing.openingStock || 0,
      });
      await inventory.save();
    }

    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('category');

    if (!product) return res.status(404).json({ message: 'Product not found' });

    const inventory = await Inventory.findOne({
      productId: product._id,
      tenantId: req.tenantId,
    });

    res.json({ product, inventory });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { sku } = req.body;

    // Check SKU uniqueness if changing
    if (sku) {
      const existing = await Product.findOne({
        sku,
        _id: { $ne: req.params.id },
        tenantId: req.tenantId,
      });
      if (existing) {
        return res.status(400).json({ message: 'SKU already exists' });
      }
    }

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    ).populate('category');

    if (!product) return res.status(404).json({ message: 'Product not found' });

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { isActive: false },
      { new: true }
    );

    if (!product) return res.status(404).json({ message: 'Product not found' });

    res.json({ message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.duplicateProduct = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!product) return res.status(404).json({ message: 'Product not found' });

    const prefix = product.productType.substring(0, 3).toUpperCase();
    const timestamp = Date.now().toString().slice(-6);
    const newSku = `${prefix}-${timestamp}`;

    const duplicated = new Product({
      ...product.toObject(),
      _id: undefined,
      sku: newSku,
      barcode: null,
      createdAt: undefined,
      updatedAt: undefined,
    });

    await duplicated.save();
    res.status(201).json(duplicated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.toggleFavorite = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!product) return res.status(404).json({ message: 'Product not found' });

    product.isFavorite = !product.isFavorite;
    await product.save();

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.importProducts = async (req, res) => {
  try {
    const { products } = req.body;

    const created = [];
    for (const productData of products) {
      const product = new Product({
        tenantId: req.tenantId,
        ...productData,
      });
      const saved = await product.save();
      created.push(saved);
    }

    res.status(201).json({ imported: created.length, products: created });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
