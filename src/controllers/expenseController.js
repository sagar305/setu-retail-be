const Expense = require('../models/Expense');

exports.getExpenses = async (req, res) => {
  try {
    const { category, status, outlet, startDate, endDate, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (category) filter.category = category;
    if (status) filter.status = status;
    if (outlet) filter.outlet = outlet;

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    const expenses = await Expense.find(filter)
      .populate('outlet', 'name')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ date: -1 });

    const total = await Expense.countDocuments(filter);

    res.json({ expenses, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createExpense = async (req, res) => {
  try {
    const { category, customCategory, description, amount, isRecurring, frequency, outlet } = req.body;

    const expense = new Expense({
      tenantId: req.tenantId,
      category,
      customCategory,
      description,
      amount,
      isRecurring,
      frequency: isRecurring ? frequency : undefined,
      outlet,
      createdBy: req.userId,
      status: 'pending',
    });

    await expense.save();
    await expense.populate('createdBy', 'name');

    res.status(201).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getExpenseById = async (req, res) => {
  try {
    const expense = await Expense.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    })
      .populate('outlet', 'name')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    res.json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    if (expense.status !== 'pending') {
      return res.status(400).json({ message: 'Cannot update approved or rejected expenses' });
    }

    Object.assign(expense, req.body);
    await expense.save();

    res.json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.approveExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    if (expense.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending expenses can be approved' });
    }

    expense.status = 'approved';
    expense.approvedBy = req.userId;
    await expense.save();

    res.json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.rejectExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    if (expense.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending expenses can be rejected' });
    }

    expense.status = 'rejected';
    expense.approvedBy = req.userId;
    await expense.save();

    res.json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.tenantId,
      status: 'pending',
    });

    if (!expense) return res.status(404).json({ message: 'Expense not found or cannot be deleted' });

    res.json({ message: 'Expense deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getExpenseStats = async (req, res) => {
  try {
    const { outlet, startDate, endDate } = req.query;
    const filter = { tenantId: req.tenantId, status: 'approved' };

    if (outlet) filter.outlet = outlet;

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    const expenses = await Expense.find(filter);

    const totalAmount = expenses.reduce((sum, e) => sum + e.amount, 0);
    const stats = {
      // Total approved spend in rupees (the UI renders this as currency)
      totalExpenses: totalAmount,
      totalAmount,
      expenseCount: expenses.length,
      byCategory: {},
      pendingCount: await Expense.countDocuments({ tenantId: req.tenantId, status: 'pending' }),
      approvedCount: await Expense.countDocuments({ tenantId: req.tenantId, status: 'approved' }),
      rejectedCount: await Expense.countDocuments({ tenantId: req.tenantId, status: 'rejected' }),
    };

    expenses.forEach((expense) => {
      const cat = expense.customCategory || expense.category;
      stats.byCategory[cat] = (stats.byCategory[cat] || 0) + expense.amount;
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
