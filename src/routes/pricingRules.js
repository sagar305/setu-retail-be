const express = require('express');
const router = express.Router();
const pricingRuleController = require('../controllers/pricingRuleController');

router.get('/', pricingRuleController.getPricingRules);
router.get('/applicable', pricingRuleController.getApplicablePricingRules);
router.post('/', pricingRuleController.createPricingRule);
router.post('/calculate', pricingRuleController.calculateAdjustedPrice);
router.get('/:id', pricingRuleController.getPricingRuleById);
router.put('/:id', pricingRuleController.updatePricingRule);
router.put('/:id/deactivate', pricingRuleController.deactivatePricingRule);

module.exports = router;
