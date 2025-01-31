const express = require('express');
const { pool } = require('../database');
const { AuditService } = require('../services/auditService');
const router = express.Router();
const authenticate = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');

// Get all roles with pagination, sorting and search
router.get('/', authenticate, checkPermission('roles.read'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 10;
    const offset = (page - 1) * perPage;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'name';
    const descending = req.query.descending === 'true';
    
    const orderDirection = descending ? 'DESC' : 'ASC';
    
    // Build search condition
    const searchCondition = search 
      ? `WHERE name ILIKE $3 OR description ILIKE $3`
      : '';
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) 
      FROM roles 
      ${searchCondition}
    `;
    
    // Get roles
    const rolesQuery = `
      SELECT 
        r.id, 
        r.name, 
        r.description, 
        r.created_at, 
        r.updated_at,
        array_agg(p.code) as permissions
      FROM roles r
      LEFT JOIN role_permissions rp ON r.id = rp.role_id
      LEFT JOIN permissions p ON rp.permission_id = p.id
      ${searchCondition}
      GROUP BY r.id
      ORDER BY r.${sortBy} ${orderDirection}
      LIMIT $1 OFFSET $2
    `;
    
    const params = [perPage, offset];
    if (search) {
      params.push(`%${search}%`);
    }
    
    const [countResult, rolesResult] = await Promise.all([
      pool.query(countQuery, search ? [`%${search}%`] : []),
      pool.query(rolesQuery, params)
    ]);

    const roles = rolesResult.rows.map(role => ({
      ...role,
      permissions: role.permissions.filter(Boolean)
    }));

    res.json({
      roles,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching roles:', error);
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while fetching roles'
    });
  }
});

// Create new role
router.post('/', authenticate, checkPermission('roles.create'), async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    
    const existingRole = await pool.query('SELECT id FROM roles WHERE name = $1', [name]);
    if (existingRole.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Role name already exists'
      });
    }
    
    // Start transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Create role
      const roleResult = await client.query(
        `INSERT INTO roles (name, description, created_at, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, name, description, created_at, updated_at`,
        [name, description]
      );

      // Add permissions
      if (permissions && permissions.length > 0) {
        const permissionValues = permissions.map((permId) => 
          `('${roleResult.rows[0].id}', '${permId}')`
        ).join(',');

        await client.query(`
          INSERT INTO role_permissions (role_id, permission_id)
          VALUES ${permissionValues}
        `);
      }

      await client.query('COMMIT');
      
      await AuditService.log({
        userId: req.user.userId,
        actionType: 'ROLE_CREATE',
        entityType: 'ROLE',
        entityId: roleResult.rows[0].id,
        newValues: { name, description, permissions },
        ipAddress: req.ip
      });

      res.status(201).json({
        success: true,
        role: {
          ...roleResult.rows[0],
          permissions: permissions || []
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating role:', error);
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while creating role'
    });
  }
});

// Update role
router.put('/:id', authenticate, checkPermission('roles.update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions } = req.body;
    
    const oldRoleData = await pool.query(
      `SELECT r.*, array_agg(p.id) as permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON r.id = rp.role_id
       LEFT JOIN permissions p ON rp.permission_id = p.id
       WHERE r.id = $1
       GROUP BY r.id`,
      [id]
    );
    
    const existingRole = await pool.query(
      'SELECT id FROM roles WHERE name = $1 AND id != $2',
      [name, id]
    );
    if (existingRole.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Role name already exists'
      });
    }
    
    // Start transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Update role
      const roleResult = await client.query(
        `UPDATE roles 
         SET name = $1,
             description = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING id, name, description, created_at, updated_at`,
        [name, description, id]
      );

      if (roleResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Role not found'
        });
      }

      // Update permissions
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      
      if (permissions && permissions.length > 0) {
        const permissionValues = permissions.map((permId) => 
          `('${id}', '${permId}')`
        ).join(',');

        await client.query(`
          INSERT INTO role_permissions (role_id, permission_id)
          VALUES ${permissionValues}
        `);
      }

      await client.query('COMMIT');

      await AuditService.log({
        userId: req.user.userId,
        actionType: 'ROLE_UPDATE',
        entityType: 'ROLE',
        entityId: id,
        oldValues: oldRoleData.rows[0],
        newValues: { name, description, permissions },
        ipAddress: req.ip
      });

      res.json({
        success: true,
        role: {
          ...roleResult.rows[0],
          permissions: permissions || []
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating role:', error);
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      entityId: req.params.id,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while updating role'
    });
  }
});

// Delete role
router.delete('/:id', authenticate, checkPermission('roles.delete'), async (req, res) => {
  try {
    const { id } = req.params;

    const roleData = await pool.query(
      'SELECT * FROM roles WHERE id = $1',
      [id]
    );
    
    if (roleData.rows[0]?.is_system) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete system role'
      });
    }

    const usersWithRole = await pool.query(
      'SELECT COUNT(*) FROM user_roles WHERE role_id = $1',
      [id]
    );
    
    if (parseInt(usersWithRole.rows[0].count) > 0) {
      await AuditService.log({
        userId: req.user.userId,
        actionType: 'ROLE_DELETE_ATTEMPT',
        entityType: 'ROLE',
        entityId: id,
        oldValues: roleData.rows[0],
        newValues: { error: 'Role is in use' },
        ipAddress: req.ip
      });
      return res.status(400).json({
        success: false,
        message: 'Cannot delete role that is assigned to users'
      });
    }
    
    const { rows } = await pool.query(
      'DELETE FROM roles WHERE id = $1 RETURNING id',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLE_DELETE',
      entityType: 'ROLE',
      entityId: id,
      oldValues: roleData.rows[0],
      ipAddress: req.ip
    });
    
    res.json({
      success: true,
      message: 'Role deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting role:', error);
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      entityId: req.params.id,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while deleting role'
    });
  }
});

module.exports = router;