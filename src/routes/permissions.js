const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission, checkMultiplePermissions } = require('../middleware/checkPermission');
const { AuditService } = require('../services/auditService');

// Get all permissions with pagination
router.get('/', authenticate, checkPermission('permissions.read'), async (req, res) => {
  try {
    let { page = 1, perPage = 10, sortBy = 'name', descending = false, search = '' } = req.query;
    
    // Convert perPage to number or null for 'All'
    if (perPage === 'All') {
      perPage = null;
    } else {
      perPage = parseInt(perPage);
      page = parseInt(page);
    }
    
    const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
    
    // Base query without LIMIT/OFFSET
    let permissionsQuery = `
      SELECT 
        p.id,
        p.name,
        p.code,
        p.is_system,
        pg.name as group_name,
        p.created_at,
        p.updated_at
      FROM permissions p
      LEFT JOIN permission_groups pg ON p.group_id = pg.id
    `;
    
    const params = [];
    let paramCounter = 1;
    
    // Add search condition if search parameter exists
    if (search) {
      permissionsQuery += `
        WHERE (p.name ILIKE $${paramCounter} OR p.code ILIKE $${paramCounter})
      `;
      params.push(`%${search}%`);
      paramCounter++;
    }
    
    // Add ordering
    permissionsQuery += ` ORDER BY p.${sortBy} ${orderDirection}`;
    
    // Add pagination if perPage is not null
    if (perPage !== null) {
      const offset = (page - 1) * perPage;
      permissionsQuery += ` LIMIT $${paramCounter} OFFSET $${paramCounter + 1}`;
      params.push(perPage, offset);
    }
    
    // Count total records (without pagination)
    const countQuery = `
      SELECT COUNT(*) 
      FROM permissions p
      ${search ? 'WHERE (p.name ILIKE $1 OR p.code ILIKE $1)' : ''}
    `;
    
    const [countResult, permissionsResult] = await Promise.all([
      pool.query(countQuery, search ? [`%${search}%`] : []),
      pool.query(permissionsQuery, params)
    ]);

    res.json({
      success: true,
      permissions: permissionsResult.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching permissions'
    });
  }
});

// Get permission groups
router.get('/groups', authenticate, checkPermission('permissions.read'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name FROM permission_groups ORDER BY name'
    );
    
    res.json({
      success: true,
      groups: result.rows
    });
  } catch (error) {
    console.error('Error fetching permission groups:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching permission groups'
    });
  }
});

// Create permission
router.post('/', authenticate, checkPermission('permissions.create'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, code, group_id } = req.body;
    
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO permissions (name, code, group_id, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [name, code, group_id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_CREATE',
      entityType: 'PERMISSION',
      entityId: result.rows[0].id,
      newValues: { name, code, group_id },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      permission: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating permission:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating permission'
    });
  } finally {
    client.release();
  }
});

// Update permission
router.put('/:id', authenticate, checkPermission('permissions.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { name, code, group_id } = req.body;

    const oldData = await client.query(
      'SELECT * FROM permissions WHERE id = $1',
      [id]
    );

    if (oldData.rows[0]?.is_system) {
      return res.status(400).json({
        success: false,
        message: 'Cannot modify system permission'
      });
    }

    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE permissions 
       SET name = $1, 
           code = $2, 
           group_id = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [name, code, group_id, id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_UPDATE',
      entityType: 'PERMISSION',
      entityId: id,
      oldValues: oldData.rows[0],
      newValues: { name, code, group_id },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      permission: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating permission:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating permission'
    });
  } finally {
    client.release();
  }
});

// Delete permission
router.delete('/:id', authenticate, checkPermission('permissions.delete'), async (req, res) => {
  try {
    const { id } = req.params;

    const permissionData = await pool.query(
      'SELECT * FROM permissions WHERE id = $1',
      [id]
    );

    if (permissionData.rows[0]?.is_system) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete system permission'
      });
    }

    await pool.query('DELETE FROM permissions WHERE id = $1', [id]);

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_DELETE',
      entityType: 'PERMISSION',
      entityId: id,
      oldValues: permissionData.rows[0],
      ipAddress: req.ip
    });

    res.json({
      success: true,
      message: 'Permission deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting permission:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting permission'
    });
  }
});
// Create permission group
router.post('/groups', authenticate, checkPermission('permissions.manage'), async (req, res) => {
  const client = await pool.connect()
  try {
    const { name, description } = req.body
    
    await client.query('BEGIN')

    const result = await client.query(
      `INSERT INTO permission_groups (name, description)
       VALUES ($1, $2)
       RETURNING *`,
      [name, description]
    )

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_GROUP_CREATE',
      entityType: 'PERMISSION_GROUP',
      entityId: result.rows[0].id,
      newValues: { name, description },
      ipAddress: req.ip
    })

    await client.query('COMMIT')

    res.status(201).json({
      success: true,
      group: result.rows[0]
    })
  } catch (error) {
    await client.query('ROLLBACK')
    res.status(500).json({
      success: false,
      message: 'Server error while creating permission group'
    })
  } finally {
    client.release()
  }
})

// Update permission group
router.put('/groups/:id', authenticate, checkPermission('permissions.manage'), async (req, res) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    const { name, description } = req.body

    const oldData = await client.query(
      'SELECT * FROM permission_groups WHERE id = $1',
      [id]
    )

    await client.query('BEGIN')

    const result = await client.query(
      `UPDATE permission_groups 
       SET name = $1, 
           description = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [name, description, id]
    )

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_GROUP_UPDATE',
      entityType: 'PERMISSION_GROUP',
      entityId: id,
      oldValues: oldData.rows[0],
      newValues: { name, description },
      ipAddress: req.ip
    })

    await client.query('COMMIT')

    res.json({
      success: true,
      group: result.rows[0]
    })
  } catch (error) {
    await client.query('ROLLBACK')
    res.status(500).json({
      success: false,
      message: 'Server error while updating permission group'
    })
  } finally {
    client.release()
  }
})

module.exports = router;