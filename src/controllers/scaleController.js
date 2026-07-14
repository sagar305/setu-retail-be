const Scale = require('../models/Scale');
const scaleService = require('../utils/scaleService');

exports.getAllScales = async (req, res) => {
  try {
    const { skip = 0, limit = 50 } = req.query;

    const scales = await Scale.find({ tenantId: req.tenantId, isActive: true })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Scale.countDocuments({ tenantId: req.tenantId, isActive: true });

    res.json({ scales, total, skip: parseInt(skip), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getScale = async (req, res) => {
  try {
    const { scaleId } = req.params;
    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });

    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    const isConnected = scaleService.isConnected(scaleId);
    res.json({ ...scale.toObject(), isConnected });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createScale = async (req, res) => {
  try {
    const { name, brand, model, serialNumber, connection, settings } = req.body;

    if (!name || !brand || !connection) {
      return res.status(400).json({ message: 'name, brand, and connection are required' });
    }

    const scale = new Scale({
      tenantId: req.tenantId,
      name,
      brand,
      model,
      serialNumber,
      connection,
      settings: {
        ...settings,
      },
    });

    await scale.save();
    res.status(201).json(scale);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateScale = async (req, res) => {
  try {
    const { scaleId } = req.params;
    const updates = req.body;

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    Object.assign(scale, updates);
    scale.updatedAt = new Date();
    await scale.save();

    res.json(scale);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteScale = async (req, res) => {
  try {
    const { scaleId } = req.params;

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    await scaleService.disconnectScale(scaleId);
    scale.isActive = false;
    await scale.save();

    res.json({ message: 'Scale deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.connectScale = async (req, res) => {
  try {
    const { scaleId } = req.params;

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    const result = await scaleService.connectScale(scale);

    if (result.success) {
      scale.status = 'connected';
      scale.lastConnection = new Date();
      scale.error = null;
      await scale.save();
    } else {
      scale.status = 'error';
      scale.error = result.error;
      await scale.save();
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.disconnectScale = async (req, res) => {
  try {
    const { scaleId } = req.params;

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    const result = await scaleService.disconnectScale(scaleId);

    if (result.success) {
      scale.status = 'disconnected';
      await scale.save();
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getWeight = async (req, res) => {
  try {
    const { scaleId } = req.params;

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    const result = scaleService.getWeight(scaleId);
    if (result.success) {
      res.json({
        weight: result.weight,
        unitType: scale.settings.unitType,
        timestamp: new Date(),
      });
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.tare = async (req, res) => {
  try {
    const { scaleId } = req.params;

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    const result = await scaleService.tare(scaleId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.generateWeightBarcode = async (req, res) => {
  try {
    const { scaleId } = req.params;
    const { sku, pricePerKg } = req.body;

    if (!sku || !pricePerKg) {
      return res.status(400).json({ message: 'sku and pricePerKg are required' });
    }

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    const result = await scaleService.generateWeightBarcode(scaleId, sku, pricePerKg);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.printBarcode = async (req, res) => {
  try {
    const { scaleId } = req.params;
    const { sku, productName, pricePerKg } = req.body;

    if (!sku || !productName || !pricePerKg) {
      return res.status(400).json({ message: 'sku, productName, and pricePerKg are required' });
    }

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    const result = await scaleService.printBarcode(scaleId, sku, productName, pricePerKg);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getConnectedScales = async (req, res) => {
  try {
    const connectedScales = scaleService.getConnectedScales();
    res.json({ connectedScales });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.calibrateScale = async (req, res) => {
  try {
    const { scaleId } = req.params;
    const { calibrationFactor, zeroOffset } = req.body;

    const scale = await Scale.findOne({ _id: scaleId, tenantId: req.tenantId });
    if (!scale) {
      return res.status(404).json({ message: 'Scale not found' });
    }

    scale.calibration = {
      lastCalibrated: new Date(),
      calibrationFactor: calibrationFactor || scale.calibration.calibrationFactor,
      zeroOffset: zeroOffset || scale.calibration.zeroOffset,
    };

    await scale.save();
    res.json({ message: 'Scale calibrated', calibration: scale.calibration });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
