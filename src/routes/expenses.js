const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');

router.get('/', expenseController.getExpenses);
router.post('/', expenseController.createExpense);
router.get('/stats/all', expenseController.getExpenseStats);
router.get('/:id', expenseController.getExpenseById);
router.put('/:id', expenseController.updateExpense);
router.put('/:id/approve', expenseController.approveExpense);
router.put('/:id/reject', expenseController.rejectExpense);
router.delete('/:id', expenseController.deleteExpense);

module.exports = router;
