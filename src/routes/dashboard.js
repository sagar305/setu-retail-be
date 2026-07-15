const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Expense = require('../models/Expense');
const Product = require('../models/Product');

router.get('/', async (req, res) => {
  try {
    const { tenantId } = req;

    // Date calculations
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 7);

    const monthStart = new Date(today);
    monthStart.setDate(1);

    const yearStart = new Date(today);
    yearStart.setMonth(0);
    yearStart.setDate(1);

    // Fetch all invoices
    const allInvoices = await Invoice.find({ tenantId });

    // Filter by date ranges
    const todayInvoices = allInvoices.filter(inv => new Date(inv.createdAt) >= today);
    const weekInvoices = allInvoices.filter(inv => new Date(inv.createdAt) >= weekStart);
    const monthInvoices = allInvoices.filter(inv => new Date(inv.createdAt) >= monthStart);
    const yearInvoices = allInvoices.filter(inv => new Date(inv.createdAt) >= yearStart);

    // Calculate sales
    const calculateTotal = (invoices) => invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const todaySales = calculateTotal(todayInvoices);
    const weekSales = calculateTotal(weekInvoices);
    const monthSales = calculateTotal(monthInvoices);
    const yearSales = calculateTotal(yearInvoices);

    // Calculate expenses
    const expenses = await Expense.find({ tenantId, date: { $gte: monthStart } });
    const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    const profit = monthSales - totalExpenses;

    // Sales trend (last 7 days)
    const salesTrend = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);

      const daySales = allInvoices
        .filter(inv => {
          const invDate = new Date(inv.createdAt);
          return invDate >= dayStart && invDate <= dayEnd;
        })
        .reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);

      salesTrend.push({
        date: date.toLocaleDateString('en-US', { weekday: 'short' }),
        sales: Math.round(daySales),
      });
    }

    // Get low stock products
    const lowStockProducts = await Product.find({
      tenantId,
      currentStock: { $lte: '$minimumStock' },
      isActive: true,
    }).limit(6);

    // Get out of stock
    const outOfStockProducts = await Product.find({
      tenantId,
      currentStock: 0,
      isActive: true,
    }).limit(3);

    // Category performance
    const categoryStats = {};
    monthInvoices.forEach(inv => {
      inv.items?.forEach(item => {
        const cat = item.category || 'Other';
        categoryStats[cat] = (categoryStats[cat] || 0) + (item.total || 0);
      });
    });

    const categoryPerformance = Object.entries(categoryStats)
      .map(([name, total]) => ({
        name,
        percentage: Math.round((total / monthSales) * 100) || 0,
        value: total,
      }))
      .sort((a, b) => b.percentage - a.percentage);

    // Recent sales
    const recentSales = allInvoices
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5)
      .map(inv => ({
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customerName || 'Walk-in',
        amount: inv.totalAmount,
        time: new Date(inv.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        date: new Date(inv.createdAt).toLocaleDateString(),
      }));

    res.json({
      sales: {
        today: todaySales,
        week: weekSales,
        month: monthSales,
        year: yearSales,
      },
      financial: {
        profit,
        revenue: monthSales,
        expenses: totalExpenses,
        pendingPayments: 2, // TODO: Calculate from supplier data
      },
      metrics: {
        transactions: todayInvoices.length,
        avgBasket: todayInvoices.length > 0 ? Math.round(todaySales / todayInvoices.length) : 0,
        lowStockCount: lowStockProducts.length,
        outOfStockCount: outOfStockProducts.length,
      },
      inventory: {
        lowStockItems: lowStockProducts,
        outOfStockItems: outOfStockProducts,
      },
      trends: {
        salesTrend,
        categoryPerformance,
      },
      recent: {
        sales: recentSales,
      },
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
