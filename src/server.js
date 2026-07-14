const express = require('express');
const cors = require('cors');
require('dotenv').config();

const connectDB = require('./config/database');
const authMiddleware = require('./middleware/auth');

const app = express();

connectDB();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', authMiddleware, require('./routes/products'));
app.use('/api/customers', authMiddleware, require('./routes/customers'));
app.use('/api/suppliers', authMiddleware, require('./routes/suppliers'));
app.use('/api/invoices', authMiddleware, require('./routes/invoices'));
app.use('/api/inventory', authMiddleware, require('./routes/inventory'));
app.use('/api/purchase-orders', authMiddleware, require('./routes/purchaseOrders'));
app.use('/api/settings', authMiddleware, require('./routes/settings'));
app.use('/api/users', authMiddleware, require('./routes/users'));
app.use('/api/roles', authMiddleware, require('./routes/roles'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
