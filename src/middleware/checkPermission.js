const { PermissionService } = require('../services/permissionService');

const checkPermission = (permissionCode) => {
  return async (req, res, next) => {
    try {
      const hasPermission = await PermissionService.hasPermission(
        req.user.userId,
        permissionCode
      );

      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Required permission: ' + permissionCode
        });
      }
      
      next();
    } catch (error) {
      console.error('Error checking permission:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while checking permissions'
      });
    }
  };
};

module.exports = checkPermission;