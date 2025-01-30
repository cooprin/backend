const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/isAdmin');
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
      dateTo 
    } = req.query;

    const offset = (page - 1) * perPage;
    const orderDirection = descending === 'true' ? 'DESC' : 'ASC';

    let conditions = [];
    let params = [perPage, offset];
    let paramIndex = 3;

    if (actionType) {
      conditions.push(`action_type = $${paramIndex}`);
      params.push(actionType);
      paramIndex++;
    }

    if (entityType) {
      conditions.push(`entity_type = $${paramIndex}`);
      params.push(entityType);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(new Date(dateFrom));
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`created_at <= $${paramIndex}`);
      params.push(new Date(dateTo));
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `
      SELECT COUNT(*)
      FROM audit_logs
      ${whereClause}
    `;

    const logsQuery = `
      SELECT 
        al.*,
        u.email as user_email
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ${whereClause}
      ORDER BY ${sortBy} ${orderDirection}
      LIMIT $1 OFFSET $2
    `;

    const [countResult, logsResult] = await Promise.all([
      pool.query(countQuery, params.slice(2)),
      pool.query(logsQuery, params)
    ]);

    res.json({
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

module.exports = router;