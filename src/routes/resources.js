const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { AuditService } = require('../services/auditService');

// Get all resources with pagination
router.get('/', authenticate, checkPermission('resources.read'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 10;
    const offset = (page - 1) * perPage;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'name';
    const descending = req.query.descending === 'true';
    
    const orderDirection = descending ? 'DESC' : 'ASC';
    
    const searchCondition = search 
      ? 'WHERE name ILIKE $3 OR code ILIKE $3'
      : '';
    
    const countQuery = `
      SELECT COUNT(*) 
      FROM resources
      ${searchCondition}
    `;
    
    const resourcesQuery = `
      SELECT *
      FROM resources
      ${searchCondition}
      ORDER BY ${sortBy} ${orderDirection}
      LIMIT $1 OFFSET $2
    `;
    
    const params = [perPage, offset];
    if (search) {
      params.push(`%${search}%`);
    }
    
    const [countResult, resourcesResult] = await Promise.all([
      pool.query(countQuery, search ? [`%${search}%`] : []),
      pool.query(resourcesQuery, params)
    ]);

    res.json({
      resources: resourcesResult.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching resources'
    });
  }
});

// Get resource actions
router.get('/:id/actions', authenticate, checkPermission('resources.read'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        a.id,
        a.name,
        a.code,
        a.description,
        ra.is_default
      FROM actions a
      LEFT JOIN resource_actions ra ON a.id = ra.action_id AND ra.resource_id = $1
      ORDER BY a.name
    `, [id]);
    
    res.json({
      success: true,
      actions: result.rows
    });
  } catch (error) {
    console.error('Error fetching resource actions:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching resource actions'
    });
  }
});

// Create resource
router.post('/', authenticate, checkPermission('resources.create'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, code, type, metadata = {} } = req.body;
    
    await client.query('BEGIN');

    // Перевірка на унікальність коду
    const existing = await client.query(
      'SELECT id FROM resources WHERE code = $1',
      [code]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Resource with this code already exists'
      });
    }

    const result = await client.query(
      `INSERT INTO resources (name, code, type, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, code, type, metadata]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'RESOURCE_CREATE',
      entityType: 'RESOURCE',
      entityId: result.rows[0].id,
      newValues: { name, code, type, metadata },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      resource: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating resource:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating resource'
    });
  } finally {
    client.release();
  }
});

// Update resource
router.put('/:id', authenticate, checkPermission('resources.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { name, metadata = {} } = req.body;

    const oldData = await client.query(
      'SELECT * FROM resources WHERE id = $1',
      [id]
    );

    if (oldData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Resource not found'
      });
    }

    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE resources 
       SET name = $1, 
           metadata = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [name, metadata, id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'RESOURCE_UPDATE',
      entityType: 'RESOURCE',
      entityId: id,
      oldValues: oldData.rows[0],
      newValues: { name, metadata },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      resource: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating resource:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating resource'
    });
  } finally {
    client.release();
  }
});

// Update resource actions
router.put('/:id/actions', authenticate, checkPermission('resources.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { actions } = req.body;

    await client.query('BEGIN');

    // Видаляємо старі зв'язки
    await client.query(
      'DELETE FROM resource_actions WHERE resource_id = $1',
      [id]
    );

    // Додаємо нові зв'язки
    if (actions && actions.length > 0) {
      const values = actions.map(action => 
        `('${id}', '${action.id}', ${action.is_default})`
      ).join(',');

      await client.query(`
        INSERT INTO resource_actions (resource_id, action_id, is_default)
        VALUES ${values}
      `);
    }

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'RESOURCE_ACTIONS_UPDATE',
      entityType: 'RESOURCE',
      entityId: id,
      newValues: { actions },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Resource actions updated successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating resource actions:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating resource actions'
    });
  } finally {
    client.release();
  }
});

// Delete resource
router.delete('/:id', authenticate, checkPermission('resources.delete'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const resourceData = await client.query(
      'SELECT * FROM resources WHERE id = $1',
      [id]
    );

    if (resourceData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Resource not found'
      });
    }

    await client.query('BEGIN');

    await client.query('DELETE FROM resources WHERE id = $1', [id]);

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'RESOURCE_DELETE',
      entityType: 'RESOURCE',
      entityId: id,
      oldValues: resourceData.rows[0],
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Resource deleted successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting resource:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting resource'
    });
  } finally {
    client.release();
  }
});

module.exports = router;