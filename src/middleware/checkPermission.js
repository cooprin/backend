const checkPermission = (permissionCode) => {
  return async (req, res, next) => {
    try {
      // Перевіряємо наявність користувача та його прав
      if (!req.user || !req.user.permissions) {
        return res.status(403).json({
          success: false,
          message: 'No permissions found'
        });
      }

      // Перевіряємо наявність конкретного права
      if (!req.user.permissions.includes(permissionCode)) {
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

// Додамо також функцію для перевірки декількох прав
const checkMultiplePermissions = (permissionCodes) => {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.permissions) {
        return res.status(403).json({
          success: false,
          message: 'No permissions found'
        });
      }

      const hasAllPermissions = permissionCodes.every(code => 
        req.user.permissions.includes(code)
      );

      if (!hasAllPermissions) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Required permissions: ' + permissionCodes.join(', ')
        });
      }

      next();
    } catch (error) {
      console.error('Error checking permissions:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while checking permissions'
      });
    }
  };
};

module.exports = {
  checkPermission,
  checkMultiplePermissions
};