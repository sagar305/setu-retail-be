const express = require('express');
const router = express.Router();
const offerController = require('../controllers/offerController');

router.get('/', offerController.getOffers);
router.get('/applicable', offerController.getApplicableOffers);
router.post('/', offerController.createOffer);
router.get('/:id', offerController.getOfferById);
router.put('/:id', offerController.updateOffer);
router.put('/:id/deactivate', offerController.deactivateOffer);

module.exports = router;
