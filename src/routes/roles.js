const express = require('express');
const { pool } = require('../database');
const { AuditService } = require('../services/auditService');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');

// Get permissions for roles
router.get('/permissions', authenticate, checkPermission('roles.read'), async (req, res) => {
  try {
    const query = `
      SELECT 
        p.id,
        p.name,
        p.code,
        pg.name as group_name
      FROM permissions p
      LEFT JOIN permission_groups pg ON p.group_id = pg.id
      ORDER BY pg.name NULLS LAST, p.name
    `;
    
    const result = await pool.query(query);

    res.json({
      success: true,
      permissions: result.rows
    });
  } catch (error) {
    console.error('Error fetching permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching permissions'
    });
  }
});

// Get role permissions
router.get('/:id/permissions', authenticate, checkPermission('roles.read'), async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT 
        p.id,
        p.name,
        p.code,
        pg.name as group_name
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      LEFT JOIN permission_groups pg ON p.group_id = pg.id
      WHERE rp.role_id = $1
      ORDER BY pg.name NULLS LAST, p.name
    `;
    
    const result = await pool.query(query, [id]);

    res.json({
      success: true,
      permissions: result.rows
    });
  } catch (error) {
    console.error('Error fetching role permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching role permissions'
    });
  }
});

// Get all roles with pagination and search
router.get('/', authenticate, checkPermission('roles.read'), async (req, res) => {
  try {
    let { 
      page = 1, 
      perPage = 10,
      sortBy = 'name',
      descending = false,
      search = '' 
    } = req.query;
    
    if (perPage === 'All') {
      perPage = null;
    } else {
      perPage = parseInt(perPage);
      page = parseInt(page);
    }
    
    const offset = perPage ? (page - 1) * perPage : 0;
    const orderDirection = descending === 'true' ? 'DESC' : 'ASC';

    // Validate sortBy
    const allowedSortColumns = ['name', 'description', 'created_at', 'updated_at'];
    if (!allowedSortColumns.includes(sortBy)) {
      sortBy = 'name';
    }
    
    const searchCondition = search 
      ? `WHERE r.name ILIKE $1 OR r.description ILIKE $1`
      : '';
    
    const rolesQuery = `
      SELECT 
        r.id, 
        r.name, 
        r.description,
        r.is_system, 
        r.created_at, 
        r.updated_at,
        array_remove(array_agg(DISTINCT p.code), null) as permission_codes,
        COUNT(DISTINCT ur.user_id) as users_count
      FROM roles r
      LEFT JOIN role_permissions rp ON r.id = rp.role_id
      LEFT JOIN permissions p ON rp.permission_id = p.id
      LEFT JOIN user_roles ur ON r.id = ur.role_id
      ${searchCondition}
      GROUP BY r.id, r.name
      ORDER BY r.${sortBy} ${orderDirection}
      ${perPage ? 'LIMIT $2 OFFSET $3' : ''}
    `;
    
    const countQuery = `
      SELECT COUNT(*)
      FROM roles r
      ${searchCondition}
    `;
    
    const queryParams = search ? [`%${search}%`] : [];
    if (perPage) {
      queryParams.push(perPage, offset);
    }
    
    const [countResult, rolesResult] = await Promise.all([
      pool.query(countQuery, search ? [`%${search}%`] : []),
      pool.query(rolesQuery, queryParams)
    ]);

    const roles = rolesResult.rows.map(role => ({
      ...role,
      permission_codes: role.permission_codes || []
    }));

    res.json({
      success: true,
      roles,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching roles:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching roles'
    });
  }
});

// Create role
router.post('/', authenticate, checkPermission('roles.create'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, permissions } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Role name is required'
      });
    }
    
    await client.query('BEGIN');
    
    const existingRole = await client.query(
      'SELECT id FROM roles WHERE name = $1',
      [name]
    );
    
    if (existingRole.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Role name already exists'
      });
    }

    // Validate permissions existence
    if (permissions && permissions.length > 0) {
      const permissionsExist = await client.query(
        'SELECT COUNT(*) FROM permissions WHERE id = ANY($1)',
        [permissions]
      );
      
      if (permissionsExist.rows[0].count !== permissions.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Some permissions do not exist'
        });
      }
    }
    
    const roleResult = await client.query(
      `INSERT INTO roles (name, description, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [name, description]
    );

    if (permissions && permissions.length > 0) {
      const permissionValues = permissions.map(permId => 
        `('${roleResult.rows[0].id}', '${permId}')`
      ).join(',');

      await client.query(`
        INSERT INTO role_permissions (role_id, permission_id)
        VALUES ${permissionValues}
      `);
    }

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLE_CREATE',
      entityType: 'ROLE',
      entityId: roleResult.rows[0].id,
      newValues: { name, description, permissions },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    const role = await pool.query(`
      SELECT 
        r.*,
        array_remove(array_agg(DISTINCT p.code), null) as permission_codes
      FROM roles r
      LEFT JOIN role_permissions rp ON r.id = rp.role_id
      LEFT JOIN permissions p ON rp.permission_id = p.id
      WHERE r.id = $1
      GROUP BY r.id
    `, [roleResult.rows[0].id]);

    res.status(201).json({
      success: true,
      role: role.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating role:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating role'
    });
  } finally {
    client.release();
  }
});

// Update role
router.put('/:id', authenticate, checkPermission('roles.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { name, description, permissions } = req.body;
    
    await client.query('BEGIN');
    
    const currentRole = await client.query(
      'SELECT * FROM roles WHERE id = $1',
      [id]
    );

    if (currentRole.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    if (currentRole.rows[0].is_system) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot modify system role'
      });
    }
    
    if (name && name !== currentRole.rows[0].name) {
      const existingRole = await client.query(
        'SELECT id FROM roles WHERE name = $1 AND id != $2',
        [name, id]
      );
      if (existingRole.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Role name already exists'
        });
      }
    }

    // Validate permissions existence
    if (permissions && permissions.length > 0) {
      const permissionsExist = await client.query(
        'SELECT COUNT(*) FROM permissions WHERE id = ANY($1)',
        [permissions]
      );
      
      if (permissionsExist.rows[0].count !== permissions.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Some permissions do not exist'
        });
      }
    }

    const roleResult = await client.query(
      `UPDATE roles 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [name, description, id]
    );

    if (permissions) {
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      
      if (permissions.length > 0) {
        const permissionValues = permissions.map(permId => 
          `('${id}', '${permId}')`
        ).join(',');

        await client.query(`
          INSERT INTO role_permissions (role_id, permission_id)
          VALUES ${permissionValues}
        `);
      }
    }

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLE_UPDATE',
      entityType: 'ROLE',
      entityId: id,
      oldValues: currentRole.rows[0],
      newValues: { name, description, permissions },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    const role = await pool.query(`
      SELECT 
        r.*,
        array_remove(array_agg(DISTINCT p.code), null) as permission_codes
      FROM roles r
      LEFT JOIN role_permissions rp ON r.id = rp.role_id
      LEFT JOIN permissions p ON rp.permission_id = p.id
      WHERE r.id = $1
      GROUP BY r.id
    `, [id]);

    res.json({
      success: true,
      role: role.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating role:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating role'
    });
  } finally {
    client.release();
  }
});

// Delete role
router.delete('/:id', authenticate, checkPermission('roles.delete'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query('BEGIN');

    const roleData = await client.query(
      'SELECT * FROM roles WHERE id = $1',
      [id]
    );

    if (!roleData.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }
    
    if (roleData.rows[0].is_system) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot delete system role'
      });
    }

    const usersWithRole = await client.query(
      'SELECT COUNT(*) FROM user_roles WHERE role_id = $1',
      [id]
    );
    
    if (parseInt(usersWithRole.rows[0].count) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot delete role that is assigned to users',
        usersCount: parseInt(usersWithRole.rows[0].count)
      });
    }

    // Delete role permissions first
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
    
    // Delete the role
    await client.query('DELETE FROM roles WHERE id = $1', [id]);

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLE_DELETE',
      entityType: 'ROLE',
      entityId: id,
      oldValues: roleData.rows[0],
      ipAddress: req.ip
    });
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: 'Role deleted successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting role:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting role'
    });
  } finally {
    client.release();
  }
});

module.exports = router;