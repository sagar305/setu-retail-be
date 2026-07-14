const express = require('express');
const router = express.Router();
const returnController = require('../controllers/returnController');

router.get('/', returnController.getReturns);
router.post('/', returnController.createReturn);
router.get('/stats/all', returnController.getReturnStats);
router.get('/:id', returnController.getReturnById);
router.put('/:id/approve', returnController.approveReturn);
router.put('/:id/reject', returnController.rejectReturn);

module.exports = router;
