const Role = require('../models/Role');

exports.getRoles = async (req, res) => {
  try {
    const roles = await Role.find({ tenantId: req.tenantId }).sort({ createdAt: -1 });

    res.json(roles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createRole = async (req, res) => {
  try {
    const { name, description, permissions } = req.body;

    const existing = await Role.findOne({
      tenantId: req.tenantId,
      name: { $regex: `^${name}$`, $options: 'i' },
    });

    if (existing) {
      return res.status(400).json({ message: 'Role with this name already exists' });
    }

    const role = new Role({
      tenantId: req.tenantId,
      name,
      description,
      permissions,
      isCustom: true,
    });

    await role.save();
    res.status(201).json(role);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRoleById = async (req, res) => {
  try {
    const role = await Role.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!role) return res.status(404).json({ message: 'Role not found' });

    res.json(role);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateRole = async (req, res) => {
  try {
    const role = await Role.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!role) return res.status(404).json({ message: 'Role not found' });

    if (!role.isCustom) {
      return res.status(400).json({ message: 'Cannot modify predefined roles' });
    }

    Object.assign(role, req.body);
    await role.save();

    res.json(role);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRole = async (req, res) => {
  try {
    const role = await Role.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!role) return res.status(404).json({ message: 'Role not found' });

    if (!role.isCustom) {
      return res.status(400).json({ message: 'Cannot delete predefined roles' });
    }

    await Role.findByIdAndDelete(req.params.id);

    res.json({ message: 'Role deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPermissions = async (req, res) => {
  try {
    const permissions = [
      { module: 'products', actions: ['view', 'create', 'edit', 'delete', 'import'] },
      { module: 'inventory', actions: ['view', 'adjust', 'transfer'] },
      { module: 'invoices', actions: ['view', 'create', 'edit', 'delete', 'print'] },
      { module: 'customers', actions: ['view', 'create', 'edit', 'delete'] },
      { module: 'suppliers', actions: ['view', 'create', 'edit', 'delete', 'payment'] },
      { module: 'purchase_orders', actions: ['view', 'create', 'approve', 'receive'] },
      { module: 'stock_transfers', actions: ['view', 'create', 'approve', 'ship', 'receive'] },
      { module: 'expenses', actions: ['view', 'create', 'approve', 'reject'] },
      { module: 'reports', actions: ['view', 'export'] },
      { module: 'settings', actions: ['view', 'edit'] },
      { module: 'users', actions: ['view', 'create', 'edit', 'delete'] },
      { module: 'roles', actions: ['view', 'create', 'edit', 'delete'] },
    ];

    res.json(permissions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
