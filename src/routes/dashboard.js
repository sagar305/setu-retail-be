const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Expense = require('../models/Expense');
const Inventory = require('../models/Inventory');
const Supplier = require('../models/Supplier');

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

    // Previous-period comparisons ("to date" ranges so they're fair)
    const inRange = (start, end) => allInvoices.filter(inv => {
      const d = new Date(inv.createdAt);
      return d >= start && d < end;
    });

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayInvoices = inRange(yesterday, today);
    const yesterdaySales = calculateTotal(yesterdayInvoices);

    const prevWeekStart = new Date(weekStart);
    prevWeekStart.setDate(weekStart.getDate() - 7);
    const prevWeekSales = calculateTotal(inRange(prevWeekStart, weekStart));

    const now = new Date();
    const prevMonthStart = new Date(monthStart);
    prevMonthStart.setMonth(monthStart.getMonth() - 1);
    const prevMonthSameDay = new Date(now);
    prevMonthSameDay.setMonth(now.getMonth() - 1);
    const prevMonthSales = calculateTotal(inRange(prevMonthStart, prevMonthSameDay));

    const prevYearStart = new Date(yearStart);
    prevYearStart.setFullYear(yearStart.getFullYear() - 1);
    const prevYearSameDay = new Date(now);
    prevYearSameDay.setFullYear(now.getFullYear() - 1);
    const prevYearSales = calculateTotal(inRange(prevYearStart, prevYearSameDay));

    // Returns null when there's no previous data to compare against
    const pctChange = (current, previous) => {
      if (!previous) return null;
      return Math.round(((current - previous) / previous) * 100);
    };

    const yesterdayAvgBasket = yesterdayInvoices.length > 0
      ? yesterdaySales / yesterdayInvoices.length
      : 0;
    const todayAvgBasket = todayInvoices.length > 0 ? todaySales / todayInvoices.length : 0;

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

    // Low / out of stock from Inventory (stock lives there, not on Product)
    const inventoryDocs = await Inventory.find({ tenantId }).populate('productId');
    const lowStockProducts = [];
    const outOfStockProducts = [];
    inventoryDocs.forEach(inv => {
      const product = inv.productId;
      if (!product) return;
      const minStock = product.inventory?.minimumStock || 0;
      if (inv.currentStock === 0) {
        outOfStockProducts.push({ name: product.name, sku: product.sku, currentStock: 0 });
      } else if (inv.currentStock <= minStock) {
        lowStockProducts.push({ name: product.name, sku: product.sku, currentStock: inv.currentStock, minimumStock: minStock });
      }
    });

    // Pending supplier payments
    const suppliers = await Supplier.find({ tenantId, outstandingBalance: { $gt: 0 } });
    const pendingPayments = suppliers.reduce((sum, s) => sum + (s.outstandingBalance || 0), 0);
    const pendingSuppliersCount = suppliers.length;

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
        pendingPayments,
        pendingSuppliersCount,
      },
      metrics: {
        transactions: todayInvoices.length,
        avgBasket: todayInvoices.length > 0 ? Math.round(todaySales / todayInvoices.length) : 0,
        lowStockCount: lowStockProducts.length,
        outOfStockCount: outOfStockProducts.length,
      },
      changes: {
        today: pctChange(todaySales, yesterdaySales),
        week: pctChange(weekSales, prevWeekSales),
        month: pctChange(monthSales, prevMonthSales),
        year: pctChange(yearSales, prevYearSales),
        transactions: pctChange(todayInvoices.length, yesterdayInvoices.length),
        avgBasket: pctChange(todayAvgBasket, yesterdayAvgBasket),
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
