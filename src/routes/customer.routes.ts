import express, { Response } from 'express';
import Customer from '../models/Customer';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = express.Router();

// Search customers
router.get('/search/:query', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const customers = await Customer.find({
      tenantId: req.user?.tenantId,
      $or: [
        { name: { $regex: req.params.query, $options: 'i' } },
        { phone: { $regex: req.params.query, $options: 'i' } },
      ],
    }).limit(20);

    res.json(customers);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Create customer
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, email } = req.body;

    const existingCustomer = await Customer.findOne({
      tenantId: req.user?.tenantId,
      phone,
    });

    if (existingCustomer) {
      return res.json(existingCustomer);
    }

    const customer = new Customer({
      tenantId: req.user?.tenantId,
      name,
      phone,
      email,
    });

    await customer.save();
    res.status(201).json(customer);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// Get customer by ID
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const customer = await Customer.findOne({
      _id: req.params.id,
      tenantId: req.user?.tenantId,
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

export default router;
