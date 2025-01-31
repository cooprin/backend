const jwt = require('jsonwebtoken');
const { PermissionService } = require('../services/permissionService');

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token is missing' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    
    // Отримуємо актуальні права користувача
    const permissions = await PermissionService.getUserPermissions(decoded.userId);
    req.user.permissions = permissions;
    
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

module.exports = authenticate;