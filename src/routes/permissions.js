const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { AuditService } = require('../services/auditService');

// Get all permissions with pagination
router.get('/', authenticate, checkPermission('permissions.read'), async (req, res) => {
  try {
    let { page = 1, perPage = 10, sortBy = 'name', descending = false, search = '' } = req.query;
    
    // Обробка параметрів
    page = Math.max(1, parseInt(page) || 1);
    perPage = perPage === 'All' ? null : parseInt(perPage) || 10;
    search = (search || '').trim();
    
    // Валідація sortBy
    const allowedSortColumns = ['name', 'code', 'created_at', 'updated_at'];
    if (!allowedSortColumns.includes(sortBy)) {
      sortBy = 'name';
    }
    
    const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
    
    // Базовий запит
    let baseQuery = `
      FROM permissions p
      LEFT JOIN permission_groups pg ON p.group_id = pg.id
    `;

    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(p.name ILIKE $${paramIndex} OR p.code ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Запит для отримання загальної кількості
    const countQuery = `
      SELECT COUNT(*)
      ${baseQuery}
      ${whereClause}
    `;

    // Основний запит для отримання даних
    let permissionsQuery = `
      SELECT 
        p.id,
        p.name,
        p.code,
        p.is_system,
        pg.name as group_name,
        p.created_at,
        p.updated_at
      ${baseQuery}
      ${whereClause}
      ORDER BY p.${sortBy} ${orderDirection}
    `;

    if (perPage !== null) {
      const offset = (page - 1) * perPage;
      permissionsQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(perPage, offset);
    }

    const [countResult, permissionsResult] = await Promise.all([
      pool.query(countQuery, search ? [params[0]] : []),
      pool.query(permissionsQuery, params)
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = perPage ? Math.ceil(total / perPage) : 1;

    res.json({
      success: true,
      permissions: permissionsResult.rows,
      pagination: {
        page,
        perPage,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error in GET /permissions:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
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
    console.error('Error in GET /permissions/groups:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
});

// Create permission
router.post('/', authenticate, checkPermission('permissions.create'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, code, group_id } = req.body;

    // Валідація
    if (!name || !code) {
      return res.status(400).json({
        success: false,
        message: 'Name and code are required'
      });
    }

    await client.query('BEGIN');

    // Перевірка унікальності коду
    const existing = await client.query(
      'SELECT id FROM permissions WHERE code = $1',
      [code]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Permission with this code already exists'
      });
    }

    // Якщо вказана група - перевіряємо її існування
    if (group_id) {
      const groupExists = await client.query(
        'SELECT id FROM permission_groups WHERE id = $1',
        [group_id]
      );

      if (groupExists.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Permission group not found'
        });
      }
    }

    const result = await client.query(
      `INSERT INTO permissions (name, code, group_id, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [name, code, group_id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_GROUP_UPDATE',
      entityType: 'PERMISSION_GROUP',
      entityId: id,
      oldValues: oldData.rows[0],
      newValues: { name, description },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      group: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in PUT /permissions/groups/:id:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  } finally {
    client.release();
  }
});

module.exports = router; 'PERMISSION_CREATE',
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
    console.error('Error in POST /permissions:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
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

    if (!name || !code) {
      return res.status(400).json({
        success: false,
        message: 'Name and code are required'
      });
    }

    const oldData = await client.query(
      'SELECT * FROM permissions WHERE id = $1',
      [id]
    );

    if (oldData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Permission not found'
      });
    }

    if (oldData.rows[0].is_system) {
      return res.status(400).json({
        success: false,
        message: 'Cannot modify system permission'
      });
    }

    await client.query('BEGIN');

    // Перевірка унікальності коду
    if (code !== oldData.rows[0].code) {
      const existing = await client.query(
        'SELECT id FROM permissions WHERE code = $1 AND id != $2',
        [code, id]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Permission with this code already exists'
        });
      }
    }

    // Перевірка існування групи
    if (group_id) {
      const groupExists = await client.query(
        'SELECT id FROM permission_groups WHERE id = $1',
        [group_id]
      );

      if (groupExists.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Permission group not found'
        });
      }
    }

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
    console.error('Error in PUT /permissions/:id:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  } finally {
    client.release();
  }
});

// Delete permission
router.delete('/:id', authenticate, checkPermission('permissions.delete'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query('BEGIN');

    const permissionData = await client.query(
      'SELECT * FROM permissions WHERE id = $1',
      [id]
    );

    if (permissionData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Permission not found'
      });
    }

    if (permissionData.rows[0].is_system) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot delete system permission'
      });
    }

    // Перевірка використання права
    const usageCount = await client.query(
      'SELECT COUNT(*) FROM role_permissions WHERE permission_id = $1',
      [id]
    );

    if (parseInt(usageCount.rows[0].count) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Permission is in use by roles and cannot be deleted'
      });
    }

    await client.query('DELETE FROM permissions WHERE id = $1', [id]);

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_DELETE',
      entityType: 'PERMISSION',
      entityId: id,
      oldValues: permissionData.rows[0],
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Permission deleted successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in DELETE /permissions/:id:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  } finally {
    client.release();
  }
});

// Create permission group
router.post('/groups', authenticate, checkPermission('permissions.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    await client.query('BEGIN');

    // Перевірка унікальності імені групи
    const existing = await client.query(
      'SELECT id FROM permission_groups WHERE name = $1',
      [name]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Permission group with this name already exists'
      });
    }

    const result = await client.query(
      `INSERT INTO permission_groups (name, description)
       VALUES ($1, $2)
       RETURNING *`,
      [name, description]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_GROUP_CREATE',
      entityType: 'PERMISSION_GROUP',
      entityId: result.rows[0].id,
      newValues: { name, description },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      group: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in POST /permissions/groups:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  } finally {
    client.release();
  }
});

// Update permission group
router.put('/groups/:id', authenticate, checkPermission('permissions.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    const oldData = await client.query(
      'SELECT * FROM permission_groups WHERE id = $1',
      [id]
    );

    if (oldData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Permission group not found'
      });
    }

    await client.query('BEGIN');

    // Перевірка унікальності імені
    if (name !== oldData.rows[0].name) {
      const existing = await client.query(
        'SELECT id FROM permission_groups WHERE name = $1 AND id != $2',
        [name, id]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Permission group with this name already exists'
        });
      }
    }

    const result = await client.query(
      `UPDATE permission_groups 
       SET name = $1, 
           description = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [name, description, id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PERMISSION_GROUP_UPDATE',
      entityType: 'PERMISSION_GROUP',
      entityId: id,
      oldValues: oldData.rows[0],
      newValues: { name, description },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      group: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating permission group:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating permission group'
    });
  } finally {
    client.release();
  }
});

module.exports = router;