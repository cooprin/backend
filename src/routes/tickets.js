const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient, staffOnly } = require('../middleware/clientAccess');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Generate unique ticket number
const generateTicketNumber = async () => {
  const year = new Date().getFullYear();
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM tickets.tickets WHERE EXTRACT(YEAR FROM created_at) = $1',
    [year]
  );
  const count = parseInt(result.rows[0].count) + 1;
  return `T${year}-${count.toString().padStart(4, '0')}`;
};

// Get ticket categories
router.get('/categories', authenticate, staffOrClient, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tickets.ticket_categories WHERE is_active = true ORDER BY sort_order'
    );

    res.json({
      success: true,
      categories: result.rows
    });
  } catch (error) {
    console.error('Error fetching ticket categories:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get tickets
router.get('/', authenticate, staffOrClient, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    let queryParams = [];
    let paramCount = 0;

    // Filter by client for client users
    if (req.user.userType === 'client') {
      whereClause = 'WHERE t.client_id = $1';
      queryParams.push(req.user.clientId);
      paramCount = 1;
    }

    // Add additional filters
    if (req.query.status) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `t.status = $${++paramCount}`;
      queryParams.push(req.query.status);
    }

    if (req.query.priority) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `t.priority = $${++paramCount}`;
      queryParams.push(req.query.priority);
    }

    if (req.query.category_id) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `t.category_id = $${++paramCount}`;
      queryParams.push(req.query.category_id);
    }

    queryParams.push(limit, offset);

    const result = await pool.query(
      `SELECT 
        t.*, 
        c.name as client_name,
        tc.name as category_name, tc.color as category_color,
        wo.name as object_name,
        u.first_name || ' ' || u.last_name as assigned_to_name,
        COUNT(tcm.id) as comments_count
       FROM tickets.tickets t
       JOIN clients.clients c ON t.client_id = c.id
       LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
       LEFT JOIN wialon.objects wo ON t.object_id = wo.id
       LEFT JOIN auth.users u ON t.assigned_to = u.id
       LEFT JOIN tickets.ticket_comments tcm ON t.id = tcm.ticket_id 
         ${req.user.userType === 'client' ? 'AND tcm.is_internal = false' : ''}
       ${whereClause}
       GROUP BY t.id, c.name, tc.name, tc.color, wo.name, u.first_name, u.last_name
       ORDER BY t.created_at DESC
       LIMIT $${++paramCount} OFFSET $${++paramCount}`,
      queryParams
    );

    // Get total count
    const countParams = queryParams.slice(0, -2); // Remove limit and offset
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT t.id) as count
       FROM tickets.tickets t
       JOIN clients.clients c ON t.client_id = c.id
       ${whereClause}`,
      countParams
    );

    res.json({
      success: true,
      tickets: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get single ticket
router.get('/:id', authenticate, staffOrClient, async (req, res) => {
  try {
    let whereClause = 'WHERE t.id = $1';
    let queryParams = [req.params.id];

    // Add client filter for client users
    if (req.user.userType === 'client') {
      whereClause += ' AND t.client_id = $2';
      queryParams.push(req.user.clientId);
    }

    const result = await pool.query(
      `SELECT 
        t.*, 
        c.name as client_name, c.email as client_email,
        tc.name as category_name, tc.color as category_color,
        wo.name as object_name,
        u.first_name || ' ' || u.last_name as assigned_to_name
       FROM tickets.tickets t
       JOIN clients.clients c ON t.client_id = c.id
       LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
       LEFT JOIN wialon.objects wo ON t.object_id = wo.id
       LEFT JOIN auth.users u ON t.assigned_to = u.id
       ${whereClause}`,
      queryParams
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    res.json({
      success: true,
      ticket: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create ticket
router.post('/', authenticate, staffOrClient, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { title, description, category_id, object_id, priority = 'medium' } = req.body;

    // Determine client_id and created_by
    let clientId, createdBy, createdByType;
    
    if (req.user.userType === 'client') {
      clientId = req.user.clientId;
      createdBy = req.user.clientId;
      createdByType = 'client';
    } else {
      // Staff creating ticket - client_id should be provided
      clientId = req.body.client_id;
      createdBy = req.user.userId;
      createdByType = 'staff';
      
      if (!clientId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'client_id is required' });
      }
    }

    const ticketNumber = await generateTicketNumber();

    const result = await client.query(
      `INSERT INTO tickets.tickets 
       (ticket_number, client_id, category_id, object_id, title, description, priority, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [ticketNumber, clientId, category_id, object_id, title, description, priority, createdBy]
    );

    const ticket = result.rows[0];

    // Create initial comment with ticket description
    if (description) {
      await client.query(
        `INSERT INTO tickets.ticket_comments 
         (ticket_id, comment_text, created_by, created_by_type)
         VALUES ($1, $2, $3, $4)`,
        [ticket.id, description, createdBy, createdByType]
      );
    }

    await client.query('COMMIT');

    // Audit log
    await AuditService.log({
      userId: req.user.userType === 'staff' ? req.user.userId : null,
      actionType: 'TICKET_CREATE',
      entityType: 'TICKET',
      entityId: ticket.id,
      newValues: ticket,
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });

    res.status(201).json({
      success: true,
      ticket
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating ticket:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

// Update ticket (staff only for status changes)
router.put('/:id', authenticate, staffOnly, async (req, res) => {
  try {
    const { status, priority, assigned_to, category_id } = req.body;
    
    const result = await pool.query(
      `UPDATE tickets.tickets 
       SET status = COALESCE($1, status),
           priority = COALESCE($2, priority),
           assigned_to = COALESCE($3, assigned_to),
           category_id = COALESCE($4, category_id),
           resolved_at = CASE WHEN $1 = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
           closed_at = CASE WHEN $1 = 'closed' THEN CURRENT_TIMESTAMP ELSE closed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [status, priority, assigned_to, category_id, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    res.json({
      success: true,
      ticket: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;