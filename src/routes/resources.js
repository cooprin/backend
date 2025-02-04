const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { AuditService } = require('../services/auditService');

// Get all resources with pagination
router.get('/', authenticate, checkPermission('resources.read'), async (req, res) => {
    try {
      let { 
        page = 1, 
        perPage = 10,
        sortBy = 'name',
        descending = false,
        search = '' 
      } = req.query;
  
      // Handle perPage=All case
      if (perPage === 'All') {
        perPage = null;
      } else {
        perPage = parseInt(perPage);
        page = parseInt(page);
      }
      
      const offset = perPage ? (page - 1) * perPage : 0;
      const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
  
      // Validate sortBy to prevent SQL injection
      const allowedSortColumns = ['name', 'code', 'type', 'created_at', 'updated_at'];
      if (!allowedSortColumns.includes(sortBy)) {
        sortBy = 'name';
      }
      
      const searchCondition = search 
        ? 'WHERE name ILIKE $1 OR code ILIKE $1 OR type ILIKE $1'
        : '';
      
      const countQuery = `
        SELECT COUNT(*) 
        FROM resources
        ${searchCondition}
      `;
      
      let resourcesQuery = `
        SELECT 
          r.*,
          (SELECT COUNT(*) FROM resource_actions ra WHERE ra.resource_id = r.id) as actions_count
        FROM resources r
        ${searchCondition}
        ORDER BY ${sortBy} ${orderDirection}
      `;
  
      const queryParams = search ? [`%${search}%`] : [];
      
      if (perPage) {
        resourcesQuery += ' LIMIT $' + (queryParams.length + 1) + ' OFFSET $' + (queryParams.length + 2);
        queryParams.push(perPage, offset);
      }
      
      const [countResult, resourcesResult] = await Promise.all([
        pool.query(countQuery, search ? [`%${search}%`] : []),
        pool.query(resourcesQuery, queryParams)
      ]);
  
      const resources = resourcesResult.rows.map(resource => ({
        ...resource,
        metadata: resource.metadata || {}
      }));
  
      res.json({
        success: true,
        resources,
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
  
      // Check if resource exists
      const resourceExists = await pool.query(
        'SELECT id FROM resources WHERE id = $1',
        [id]
      );
  
      if (resourceExists.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Resource not found'
        });
      }
      
      const result = await pool.query(`
        SELECT 
          a.id,
          a.name,
          a.code,
          a.description,
          COALESCE(ra.is_default, false) as is_default
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
  
  // Validate metadata object
  const validateMetadata = (metadata) => {
    if (typeof metadata !== 'object' || metadata === null) {
      return false;
    }
  
    // Add any specific metadata validation rules here
    return true;
  };
  
  // Create resource
  router.post('/', authenticate, checkPermission('resources.create'), async (req, res) => {
    const client = await pool.connect();
    try {
      const { name, code, type, metadata = {} } = req.body;
  
      // Validate required fields
      if (!name || !code || !type) {
        return res.status(400).json({
          success: false,
          message: 'Name, code and type are required fields'
        });
      }
  
      // Validate metadata
      if (!validateMetadata(metadata)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid metadata format'
        });
      }
      
      await client.query('BEGIN');
  
      // Check for unique code
      const existing = await client.query(
        'SELECT id FROM resources WHERE code = $1',
        [code]
      );
  
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Resource with this code already exists'
        });
      }
  
      const result = await client.query(
        `INSERT INTO resources (name, code, type, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
        resource: {
          ...result.rows[0],
          metadata: result.rows[0].metadata || {}
        }
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
  
      // Validate metadata
      if (!validateMetadata(metadata)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid metadata format'
        });
      }
  
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
        resource: {
          ...result.rows[0],
          metadata: result.rows[0].metadata || {}
        }
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
  
      // Validate actions array
      if (!Array.isArray(actions)) {
        return res.status(400).json({
          success: false,
          message: 'Actions must be an array'
        });
      }
  
      await client.query('BEGIN');
  
      // Check if resource exists
      const resourceExists = await client.query(
        'SELECT id FROM resources WHERE id = $1',
        [id]
      );
  
      if (resourceExists.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Resource not found'
        });
      }
  
      // Delete old actions
      await client.query(
        'DELETE FROM resource_actions WHERE resource_id = $1',
        [id]
      );
  
      // Add new actions
      if (actions.length > 0) {
        const actionValues = actions.map(action => 
          `($1, ${action.id}, ${!!action.is_default})`
        ).join(',');
  
        await client.query(`
          INSERT INTO resource_actions (resource_id, action_id, is_default)
          VALUES ${actionValues}
        `, [id]);
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
      const { force } = req.query;
  
      await client.query('BEGIN');
  
      // Check if resource exists and get its data
      const resourceData = await client.query(
        'SELECT * FROM resources WHERE id = $1',
        [id]
      );
  
      if (resourceData.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Resource not found'
        });
      }
  
      // Check for dependencies
      const [actionCount, auditCount] = await Promise.all([
        client.query('SELECT COUNT(*) FROM resource_actions WHERE resource_id = $1', [id]),
        client.query('SELECT COUNT(*) FROM audit_logs WHERE entity_type = $1 AND entity_id = $2', ['RESOURCE', id])
      ]);
  
      if (!force && (parseInt(actionCount.rows[0].count) > 0 || parseInt(auditCount.rows[0].count) > 0)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          message: 'Resource has dependencies',
          dependencies: {
            actions: parseInt(actionCount.rows[0].count),
            auditLogs: parseInt(auditCount.rows[0].count)
          }
        });
      }
  
      // Delete related records if force=true
      if (force) {
        await Promise.all([
          client.query('DELETE FROM resource_actions WHERE resource_id = $1', [id]),
          client.query('DELETE FROM audit_logs WHERE entity_type = $1 AND entity_id = $2', ['RESOURCE', id])
        ]);
      }
  
      // Delete the resource
      await client.query('DELETE FROM resources WHERE id = $1', [id]);
  
      await AuditService.log({
        userId: req.user.userId,
        actionType: force ? 'RESOURCE_DELETE_FORCE' : 'RESOURCE_DELETE',
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