const express = require('express');
const router = express.Router();
const couponController = require('../controllers/couponController');

router.get('/', couponController.getCoupons);
router.post('/', couponController.createCoupon);
router.post('/validate', couponController.validateCoupon);
router.get('/:id', couponController.getCouponById);
router.put('/:id', couponController.updateCoupon);
router.put('/:id/deactivate', couponController.deactivateCoupon);

module.exports = router;
