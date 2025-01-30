const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const { pool } = require('../database');

// Get audit logs
router.get('/', authenticate, isAdmin, async (req, res) => {
    try {
      const { 
        page = 1, 
        perPage = 10,
        sortBy = 'created_at',
        descending = true,
        actionType,
        entityType,
        dateFrom,
        dateTo,
        search 
      } = req.query;
  
      const offset = (page - 1) * perPage;
      const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
  
      let conditions = [];
      let params = [perPage, offset];
      let paramIndex = 3;
  
      if (search) {
        conditions.push(`(
          COALESCE(u.email, '') ILIKE $${paramIndex} OR 
          COALESCE(al.action_type, '') ILIKE $${paramIndex} OR 
          COALESCE(al.entity_type, '') ILIKE $${paramIndex}
        )`);
        params.push(`%${search}%`);
        paramIndex++;
      }
  
      if (actionType) {
        conditions.push(`al.action_type = $${paramIndex}`);
        params.push(actionType);
        paramIndex++;
      }
  
      if (entityType) {
        conditions.push(`al.entity_type = $${paramIndex}`);
        params.push(entityType);
        paramIndex++;
      }
  
      if (dateFrom) {
        conditions.push(`al.created_at >= $${paramIndex}::timestamp`);
        params.push(dateFrom);
        paramIndex++;
      }
  
      if (dateTo) {
        // Додаємо 1 день до кінцевої дати, щоб включити весь день
        conditions.push(`al.created_at < ($${paramIndex}::timestamp + interval '1 day')`);
        params.push(dateTo);
        paramIndex++;
      }
  
      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  
      const countQuery = `
        SELECT COUNT(*)
        FROM audit_logs al
        LEFT JOIN users u ON al.user_id = u.id
        ${whereClause}
      `;
  
      const logsQuery = `
        SELECT 
          al.*,
          u.email as user_email
        FROM audit_logs al
        LEFT JOIN users u ON al.user_id = u.id
        ${whereClause}
        ORDER BY al.${sortBy} ${orderDirection}
        LIMIT $1 OFFSET $2
      `;
  
      const [countResult, logsResult] = await Promise.all([
        pool.query(countQuery, conditions.length ? params.slice(2) : []),
        pool.query(logsQuery, params)
      ]);
  
      res.json({
        success: true,
        logs: logsResult.rows,
        total: parseInt(countResult.rows[0].count)
      });
    } catch (error) {
      console.error('Error fetching audit logs:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching audit logs'
      });
    }
  });
// Get unique action and entity types
router.get('/types', authenticate, isAdmin, async (req, res) => {
    try {
      const actionTypesQuery = `
        SELECT DISTINCT action_type 
        FROM audit_logs 
        WHERE action_type IS NOT NULL
        ORDER BY action_type`;
  
      const entityTypesQuery = `
        SELECT DISTINCT entity_type 
        FROM audit_logs 
        WHERE entity_type IS NOT NULL
        ORDER BY entity_type`;
  
      const [actionTypes, entityTypes] = await Promise.all([
        pool.query(actionTypesQuery),
        pool.query(entityTypesQuery)
      ]);
  
      res.json({
        success: true,
        actionTypes: actionTypes.rows.map(row => row.action_type),
        entityTypes: entityTypes.rows.map(row => row.entity_type)
      });
    } catch (error) {
      console.error('Error fetching log types:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching log types'
      });
    }
  });

module.exports = router;