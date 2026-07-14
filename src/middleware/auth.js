const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  try {
    let token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.tenantId = decoded.tenantId;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

module.exports = auth;
