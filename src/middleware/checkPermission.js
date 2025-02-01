const { pool } = require('../database');

const checkPermission = (permissionCode) => {
  return async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT EXISTS (
          SELECT 1
          FROM user_roles ur
          JOIN role_permissions rp ON ur.role_id = rp.role_id
          JOIN permissions p ON rp.permission_id = p.id
          WHERE ur.user_id = $1 AND p.code = $2
        ) as has_permission`,
        [req.user.userId, permissionCode]
      );

      if (!result.rows[0].has_permission) {
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