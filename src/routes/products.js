const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const { v4: uuidv4 } = require('uuid');

router.get('/', async (req, res) => {
  try {
    const { type, category, isFavorite } = req.query;
    const filter = { tenantId: req.tenantId };

    if (type && type !== 'all') filter.productType = type;
    if (category) filter.category = category;
    if (isFavorite === 'true') filter.isFavorite = true;

    const products = await Product.find(filter).populate('category');
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, productType } = req.body;
    const sku = `${productType.substring(0, 3).toUpperCase()}-${Date.now()}`;

    const product = new Product({
      tenantId: req.tenantId,
      ...req.body,
      sku,
    });
    await product.save();
    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.tenantId,
    });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/duplicate', async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const duplicated = new Product({
      ...product.toObject(),
      _id: undefined,
      sku: `${product.sku}-DUP-${Date.now()}`,
      barcode: null,
    });
    await duplicated.save();
    res.status(201).json(duplicated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/favorite', async (req, res) => {
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
});

module.exports = router;
