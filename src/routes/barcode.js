const express = require('express');
const router = express.Router();
const barcodeService = require('../utils/barcodeService');

router.post('/ean13', async (req, res) => {
  try {
    const { code } = req.body;
    const result = await barcodeService.generateEAN13(code);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.set('Content-Type', 'image/png');
    res.send(result.buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/qrcode', async (req, res) => {
  try {
    const { data } = req.body;
    const result = await barcodeService.generateQRCode(data);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.set('Content-Type', 'image/png');
    res.send(result.buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/product', async (req, res) => {
  try {
    const { sku, productName } = req.body;
    const result = await barcodeService.generateProductBarcode(sku, productName);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.set('Content-Type', 'image/png');
    res.send(result.buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/weight-based', async (req, res) => {
  try {
    const { sku, weight, price } = req.body;
    const barcodeCode = barcodeService.generateWeightBasedBarcode(sku, weight, price);
    const result = await barcodeService.generateEAN13(barcodeCode);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.set('Content-Type', 'image/png');
    res.json({ barcode: barcodeCode, success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/invoice-qr', async (req, res) => {
  try {
    const { invoiceNumber, amount, customerPhone } = req.body;
    const result = await barcodeService.generateInvoiceQR(invoiceNumber, amount, customerPhone);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.set('Content-Type', 'image/png');
    res.send(result.buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
