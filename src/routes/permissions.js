const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission, checkMultiplePermissions } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get all permissions with pagination
router.get('/', authenticate, checkPermission('permissions.read'), async (req, res) => {
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
    
    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(p.name ILIKE $${paramIndex} OR p.code ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    
    let permissionsQuery = `
      SELECT 
        p.id,
        p.name,
        p.code,
        p.is_system,
        pg.name as group_name,
        p.created_at,
        p.updated_at
      FROM auth.permissions p
      LEFT JOIN auth.permission_groups pg ON p.group_id = pg.id
      ${whereClause}
      ORDER BY p.${sortBy} ${orderDirection}
    `;
    
    if (perPage) {
      permissionsQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(perPage, offset);
    }
    
    const countQuery = `
      SELECT COUNT(*) 
      FROM auth.permissions p
      ${whereClause}
    `;
    
    const [countResult, permissionsResult] = await Promise.all([
      pool.query(countQuery, conditions.length ? [params[0]] : []),
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
      'SELECT id, name FROM auth.permission_groups ORDER BY name'
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
      `INSERT INTO auth.permissions (name, code, group_id, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [name, code, group_id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: AUDIT_LOG_TYPES.PERMISSION.CREATE,
      entityType: ENTITY_TYPES.PERMISSION,
      entityId: result.rows[0].id,
      newValues: { name, code, group_id },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,req
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
      'SELECT * FROM auth.permissions WHERE id = $1',
      [id]
    );


    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE auth.permissions 
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
      actionType: AUDIT_LOG_TYPES.PERMISSION.UPDATE,
      entityType: ENTITY_TYPES.PERMISSION,
      entityId: id,
      oldValues: oldData.rows[0],
      newValues: { name, code, group_id },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
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
      'SELECT * FROM auth.permissions WHERE id = $1',
      [id]
    );


    await pool.query('DELETE FROM auth.permissions WHERE id = $1', [id]);

    await AuditService.log({
      userId: req.user.userId,
      actionType: AUDIT_LOG_TYPES.PERMISSION.DELETE,
      entityType: ENTITY_TYPES.PERMISSION,
      entityId: id,
      oldValues: permissionData.rows[0],
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
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
      `INSERT INTO auth.permission_groups (name, description)
       VALUES ($1, $2)
       RETURNING *`,
      [name, description]
    )

    await AuditService.log({
      userId: req.user.userId,
      actionType: AUDIT_LOG_TYPES.PERMISSION.GROUP_CREATE,
      entityType: ENTITY_TYPES.PERMISSION_GROUP,  
      entityId: result.rows[0].id,
      newValues: { name, description },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });

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
      'SELECT * FROM auth.permission_groups WHERE id = $1',
      [id]
    )

    await client.query('BEGIN')

    const result = await client.query(
      `UPDATE auth.permission_groups 
       SET name = $1, 
           description = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [name, description, id]
    )

    await AuditService.log({
      userId: req.user.userId,
      actionType: AUDIT_LOG_TYPES.PERMISSION.GROUP_UPDATE,
      entityType: ENTITY_TYPES.PERMISSION_GROUP,
      entityId: id,
      oldValues: oldData.rows[0],
      newValues: { name, description },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });

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