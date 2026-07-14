const express = require('express');
const router = express.Router();
const scaleController = require('../controllers/scaleController');

router.get('/', scaleController.getAllScales);
router.get('/connected', scaleController.getConnectedScales);
router.get('/:scaleId', scaleController.getScale);
router.post('/', scaleController.createScale);
router.put('/:scaleId', scaleController.updateScale);
router.delete('/:scaleId', scaleController.deleteScale);

router.post('/:scaleId/connect', scaleController.connectScale);
router.post('/:scaleId/disconnect', scaleController.disconnectScale);

router.get('/:scaleId/weight', scaleController.getWeight);
router.post('/:scaleId/tare', scaleController.tare);
router.post('/:scaleId/calibrate', scaleController.calibrateScale);

router.post('/:scaleId/barcode/weight-based', scaleController.generateWeightBarcode);
router.post('/:scaleId/print-barcode', scaleController.printBarcode);

module.exports = router;
