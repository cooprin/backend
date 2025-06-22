const jwt = require('jsonwebtoken');
const { pool } = require('../database');

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token is missing' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if this is a staff or client token
    if (decoded.userType === 'staff') {
      // Staff user - existing logic
      req.user = {
        userId: decoded.userId,
        userType: 'staff',
        email: decoded.email,
        permissions: decoded.permissions
      };
    } else if (decoded.userType === 'client') {
      // Client user - new logic
      req.user = {
        clientId: decoded.clientId,
        userType: 'client',
        wialonUsername: decoded.wialonUsername,
        permissions: decoded.permissions || ['customer_portal.read', 'tickets.read', 'tickets.create', 'chat.read', 'chat.create']
      };
    } else {
      return res.status(401).json({ message: 'Invalid token type' });
    }

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

module.exports = authenticate;