const { pool } = require('../database');

class PermissionService {
  // Отримання всіх прав користувача
  static async getUserPermissions(userId) {
    const query = `
      SELECT DISTINCT p.code
      FROM auth.permissions p
      JOIN auth.role_permissions rp ON p.id = rp.permission_id
      JOIN auth.user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1
    `;
    
    const result = await pool.query(query, [userId]);
    return result.rows.map(row => row.code);
  }

  // Перевірка наявності права
  static async hasPermission(userId, permissionCode) {
    const query = `
      SELECT EXISTS (
        SELECT 1
        FROM auth.permissions p
        JOIN auth.role_permissions rp ON p.id = rp.permission_id
        JOIN auth.user_roles ur ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1 AND p.code = $2
      ) as has_permission
    `;
    
    const result = await pool.query(query, [userId, permissionCode]);
    return result.rows[0].has_permission;
  }
}

module.exports = { PermissionService };