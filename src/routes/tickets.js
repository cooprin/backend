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

// Dashboard metrics routes

// Get tickets metrics for dashboard
router.get('/metrics', authenticate, staffOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(CASE WHEN status = 'open' THEN 1 END) as new_count,
        COUNT(CASE WHEN status IN ('in_progress', 'waiting_client') THEN 1 END) as in_progress_count,
        COUNT(CASE WHEN priority = 'urgent' AND status NOT IN ('resolved', 'closed', 'cancelled') THEN 1 END) as urgent_count,
        COUNT(CASE WHEN status = 'resolved' AND DATE(resolved_at) = CURRENT_DATE THEN 1 END) as resolved_today_count
      FROM tickets.tickets
    `);

    res.json({
      success: true,
      metrics: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching tickets metrics:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get tickets status distribution for chart
router.get('/status-distribution', authenticate, staffOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM tickets.tickets
      GROUP BY status
      ORDER BY count DESC
    `);

    res.json({
      success: true,
      distribution: result.rows
    });
  } catch (error) {
    console.error('Error fetching tickets status distribution:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get recent tickets
router.get('/recent', authenticate, staffOnly, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const result = await pool.query(`
      SELECT 
        t.id,
        t.ticket_number,
        t.title,
        t.priority,
        t.status,
        t.created_at,
        c.name as client_name
      FROM tickets.tickets t
      JOIN clients.clients c ON t.client_id = c.id
      ORDER BY t.created_at DESC
      LIMIT $1
    `, [limit]);

    res.json({
      success: true,
      tickets: result.rows
    });
  } catch (error) {
    console.error('Error fetching recent tickets:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get tickets by category statistics
router.get('/by-category', authenticate, staffOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        tc.id as category_id,
        tc.name as category_name,
        tc.color as category_color,
        COUNT(t.id) as total_count,
        COUNT(CASE WHEN t.status = 'open' THEN 1 END) as new_count,
        COUNT(CASE WHEN t.status IN ('in_progress', 'waiting_client') THEN 1 END) as in_progress_count,
        COUNT(CASE WHEN t.status IN ('resolved', 'closed') THEN 1 END) as resolved_count,
        AVG(
          CASE 
            WHEN t.status IN ('resolved', 'closed') AND t.resolved_at IS NOT NULL 
            THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600
          END
        ) as avg_resolution_time
      FROM tickets.ticket_categories tc
      LEFT JOIN tickets.tickets t ON tc.id = t.category_id
      WHERE tc.is_active = true
      GROUP BY tc.id, tc.name, tc.color
      ORDER BY total_count DESC
    `);

    res.json({
      success: true,
      categories: result.rows
    });
  } catch (error) {
    console.error('Error fetching tickets by category:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

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

    // Status filter - supports both single status and array
    if (req.query.status) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      
      // Handle comma-separated statuses or arrays
      let statuses;
      if (Array.isArray(req.query.status)) {
        statuses = req.query.status;
      } else if (typeof req.query.status === 'string' && req.query.status.includes(',')) {
        statuses = req.query.status.split(',');
      } else {
        statuses = [req.query.status];
      }

      if (statuses.length === 1) {
        whereClause += `t.status = $${++paramCount}`;
        queryParams.push(statuses[0]);
      } else {
        const statusPlaceholders = statuses.map(() => `$${++paramCount}`).join(',');
        whereClause += `t.status IN (${statusPlaceholders})`;
        queryParams.push(...statuses);
      }
    }

    // Priority filter - supports multiple priorities
    if (req.query.priority) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      
      let priorities;
      if (Array.isArray(req.query.priority)) {
        priorities = req.query.priority;
      } else if (typeof req.query.priority === 'string' && req.query.priority.includes(',')) {
        priorities = req.query.priority.split(',');
      } else {
        priorities = [req.query.priority];
      }

      if (priorities.length === 1) {
        whereClause += `t.priority = $${++paramCount}`;
        queryParams.push(priorities[0]);
      } else {
        const priorityPlaceholders = priorities.map(() => `$${++paramCount}`).join(',');
        whereClause += `t.priority IN (${priorityPlaceholders})`;
        queryParams.push(...priorities);
      }
    }

    // Category filter - supports multiple categories
    if (req.query.category_id) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      
      let categories;
      if (Array.isArray(req.query.category_id)) {
        categories = req.query.category_id;
      } else if (typeof req.query.category_id === 'string' && req.query.category_id.includes(',')) {
        categories = req.query.category_id.split(',');
      } else {
        categories = [req.query.category_id];
      }

      if (categories.length === 1) {
        whereClause += `t.category_id = $${++paramCount}`;
        queryParams.push(categories[0]);
      } else {
        const categoryPlaceholders = categories.map(() => `$${++paramCount}`).join(',');
        whereClause += `t.category_id IN (${categoryPlaceholders})`;
        queryParams.push(...categories);
      }
    }

    // Assigned to filter
    if (req.query.assigned_to) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      if (req.query.assigned_to === 'unassigned') {
        whereClause += `t.assigned_to IS NULL`;
      } else {
        whereClause += `t.assigned_to = $${++paramCount}`;
        queryParams.push(req.query.assigned_to);
      }
    }

    // Client filter (for staff only)
    if (req.query.client_id && req.user.userType === 'staff') {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `t.client_id = $${++paramCount}`;
      queryParams.push(req.query.client_id);
    }

    // Search filter
    if (req.query.search) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `(t.title ILIKE $${++paramCount} OR t.description ILIKE $${++paramCount} OR t.ticket_number ILIKE $${++paramCount} OR c.name ILIKE $${++paramCount})`;
      const searchTerm = `%${req.query.search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Date filters
    if (req.query.created_from) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(t.created_at) >= $${++paramCount}`;
      queryParams.push(req.query.created_from);
    }

    if (req.query.created_to) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(t.created_at) <= $${++paramCount}`;
      queryParams.push(req.query.created_to);
    }

    if (req.query.date_from) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(t.resolved_at) >= $${++paramCount}`;
      queryParams.push(req.query.date_from);
    }

    if (req.query.date_to) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(t.resolved_at) <= $${++paramCount}`;
      queryParams.push(req.query.date_to);
    }

    if (req.query.updated_from) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(t.updated_at) >= $${++paramCount}`;
      queryParams.push(req.query.updated_from);
    }

    if (req.query.updated_to) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(t.updated_at) <= $${++paramCount}`;
      queryParams.push(req.query.updated_to);
    }

    // Resolved by filter
    if (req.query.resolved_by) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `t.resolved_by = $${++paramCount}`;
      queryParams.push(req.query.resolved_by);
    }

    // Sorting
    let orderBy = 'ORDER BY t.created_at DESC'; // default
    if (req.query.sortBy) {
      const allowedSortFields = [
        'created_at', 'updated_at', 'resolved_at', 'title', 'ticket_number', 
        'priority', 'status', 'client_name', 'assigned_to_name'
      ];
      
      if (allowedSortFields.includes(req.query.sortBy)) {
        const direction = req.query.sortDesc === 'true' ? 'DESC' : 'ASC';
        
        // Handle special cases for sorting
        if (req.query.sortBy === 'client_name') {
          orderBy = `ORDER BY c.name ${direction}`;
        } else if (req.query.sortBy === 'assigned_to_name') {
          orderBy = `ORDER BY u.first_name ${direction}, u.last_name ${direction}`;
        } else {
          orderBy = `ORDER BY t.${req.query.sortBy} ${direction}`;
        }
      }
    }

    // Add limit and offset to params
    queryParams.push(limit, offset);

    const result = await pool.query(
      `SELECT 
        t.*, 
        c.name as client_name,
        c.email as client_email,
        tc.name as category_name, 
        tc.color as category_color,
        wo.name as object_name,
        u.first_name || ' ' || u.last_name as assigned_to_name,
        ur.first_name || ' ' || ur.last_name as resolved_by_name,
        COUNT(tcm.id) as comments_count,
        (
          SELECT json_build_object(
            'id', last_comment.id,
            'comment_text', last_comment.comment_text,
            'created_at', last_comment.created_at,
            'author_name', 
            CASE 
              WHEN last_comment.created_by_type = 'client' THEN lc_client.name
              ELSE lc_user.first_name || ' ' || lc_user.last_name
            END,
            'created_by_type', last_comment.created_by_type
          )
          FROM tickets.ticket_comments last_comment
          LEFT JOIN clients.clients lc_client ON last_comment.created_by_type = 'client' AND last_comment.created_by::text = lc_client.id::text
          LEFT JOIN auth.users lc_user ON last_comment.created_by_type = 'staff' AND last_comment.created_by = lc_user.id
          WHERE last_comment.ticket_id = t.id 
            ${req.user.userType === 'client' ? 'AND last_comment.is_internal = false' : ''}
          ORDER BY last_comment.created_at DESC 
          LIMIT 1
        ) as last_comment
       FROM tickets.tickets t
       JOIN clients.clients c ON t.client_id = c.id
       LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
       LEFT JOIN wialon.objects wo ON t.object_id = wo.id
       LEFT JOIN auth.users u ON t.assigned_to = u.id
       LEFT JOIN auth.users ur ON t.resolved_by = ur.id
       LEFT JOIN tickets.ticket_comments tcm ON t.id = tcm.ticket_id 
         ${req.user.userType === 'client' ? 'AND tcm.is_internal = false' : ''}
       ${whereClause}
       GROUP BY t.id, c.name, c.email, tc.name, tc.color, wo.name, u.first_name, u.last_name, ur.first_name, ur.last_name
       ${orderBy}
       LIMIT $${++paramCount} OFFSET $${++paramCount}`,
      queryParams
    );

    // Get total count (remove limit and offset from params)
    const countParams = queryParams.slice(0, -2);
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT t.id) as count
       FROM tickets.tickets t
       JOIN clients.clients c ON t.client_id = c.id
       LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
       LEFT JOIN wialon.objects wo ON t.object_id = wo.id
       LEFT JOIN auth.users u ON t.assigned_to = u.id
       LEFT JOIN auth.users ur ON t.resolved_by = ur.id
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
        u.first_name || ' ' || u.last_name as assigned_to_name,
        ur.first_name || ' ' || ur.last_name as resolved_by_name
       FROM tickets.tickets t
       JOIN clients.clients c ON t.client_id = c.id
       LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
       LEFT JOIN wialon.objects wo ON t.object_id = wo.id
       LEFT JOIN auth.users u ON t.assigned_to = u.id
       LEFT JOIN auth.users ur ON t.resolved_by = ur.id
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

    const { title, description, category_id, object_id, priority = 'medium', assigned_to } = req.body;

    // Validate required fields
    if (!title || !description) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'Title and description are required' 
      });
    }

    // Determine client_id, created_by, and created_by_type
    let clientId, createdBy, createdByType;
    
    if (req.user.userType === 'client') {
      clientId = req.user.clientId;
      createdBy = req.user.clientId;
      createdByType = 'client';

      // Validate object belongs to client if specified
      if (object_id) {
        const objectCheck = await client.query(
          'SELECT id FROM wialon.objects WHERE id = $1 AND client_id = $2',
          [object_id, req.user.clientId]
        );
        
        if (objectCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            success: false, 
            message: 'Object not found or access denied' 
          });
        }
      }
    } else {
      // Staff creating ticket - client_id should be provided
      clientId = req.body.client_id;
      createdBy = req.user.userId;
      createdByType = 'staff';
      
      if (!clientId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'client_id is required' });
      }

      // Validate client exists
      const clientCheck = await client.query(
        'SELECT id FROM clients.clients WHERE id = $1',
        [clientId]
      );
      
      if (clientCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Client not found' });
      }
    }

    const ticketNumber = await generateTicketNumber();

    const result = await client.query(
      `INSERT INTO tickets.tickets 
       (ticket_number, client_id, category_id, object_id, title, description, priority, assigned_to, created_by, created_by_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [ticketNumber, clientId, category_id, object_id, title, description, priority, assigned_to, createdBy, createdByType]
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


  // Audit log for both staff and clients
    try {
      if (req.user.userType === 'staff') {
        await AuditService.log({
          userId: req.user.userId,
          userType: 'staff',
          actionType: AUDIT_LOG_TYPES.TICKET.CREATE,
          entityType: ENTITY_TYPES.TICKET,
          entityId: ticket.id,
          newValues: {
            ticket_id: ticket.id,
            ticket_number: ticket.ticket_number,
            title: ticket.title,
            client_id: ticket.client_id,
            category_id: ticket.category_id,
            priority: ticket.priority,
            created_by_staff: req.user.userId
          },
          ipAddress: req.ip,
          auditType: AUDIT_TYPES.BUSINESS,
          req
        });
      } else {
        await AuditService.log({
          clientId: req.user.clientId,
          userType: 'client',
          actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.CREATE_TICKET,
          entityType: ENTITY_TYPES.TICKET,
          entityId: ticket.id,
          newValues: {
            ticket_id: ticket.id,
            ticket_number: ticket.ticket_number,
            title: ticket.title,
            client_id: req.user.clientId,
            category_id: ticket.category_id,
            priority: ticket.priority
          },
          ipAddress: req.ip,
          auditType: AUDIT_TYPES.BUSINESS,
          req
        });
      }
    } catch (auditError) {
      console.error('Audit log failed:', auditError);
    }

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
    
    // Build dynamic update query
    let updateFields = [];
    let updateValues = [];
    let paramCount = 0;

    if (status !== undefined) {
      updateFields.push(`status = $${++paramCount}`);
      updateValues.push(status);
    }

    if (priority !== undefined) {
      updateFields.push(`priority = $${++paramCount}`);
      updateValues.push(priority);
    }

    if (assigned_to !== undefined) {
      updateFields.push(`assigned_to = $${++paramCount}`);
      updateValues.push(assigned_to);
    }

    if (category_id !== undefined) {
      updateFields.push(`category_id = $${++paramCount}`);
      updateValues.push(category_id);
    }

    // Always update the updated_at timestamp
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

    // Handle resolved_at and closed_at based on status
    if (status === 'resolved') {
      updateFields.push(`resolved_at = CURRENT_TIMESTAMP`);
      updateFields.push(`resolved_by = $${++paramCount}`);
      updateValues.push(req.user.userId);
    } else if (status === 'closed') {
      updateFields.push(`closed_at = CURRENT_TIMESTAMP`);
      updateFields.push(`closed_by = $${++paramCount}`);
      updateValues.push(req.user.userId);
    }

    // Add ticket ID as last parameter
    updateValues.push(req.params.id);

    const result = await pool.query(
      `UPDATE tickets.tickets 
       SET ${updateFields.join(', ')}
       WHERE id = $${++paramCount}
       RETURNING *`,
      updateValues
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Audit log for staff actions
    try {
      await AuditService.log({
        userId: req.user.userId,
        userType: 'staff',
        actionType: AUDIT_LOG_TYPES.TICKET.UPDATE,
        entityType: ENTITY_TYPES.TICKET,
        entityId: req.params.id,
        newValues: {
          ticket_id: req.params.id,
          status: result.rows[0].status,
          priority: result.rows[0].priority,
          assigned_to: result.rows[0].assigned_to,
          category_id: result.rows[0].category_id,
          updated_by: req.user.userId,
          updated_at: result.rows[0].updated_at
        },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });
    } catch (auditError) {
      console.error('Audit log failed:', auditError);
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

// Bulk assign tickets
router.post('/bulk-assign', authenticate, staffOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { ticket_ids, assigned_to, comment, notify_assignee, notify_clients, new_status } = req.body;

    if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'ticket_ids array is required' 
      });
    }

    if (!assigned_to) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'assigned_to is required' 
      });
    }

    // Build update query
    let updateFields = ['assigned_to = $1', 'updated_at = CURRENT_TIMESTAMP'];
    let updateParams = [assigned_to];
    let paramCount = 1;

    if (new_status) {
      updateFields.push(`status = $${++paramCount}`);
      updateParams.push(new_status);
    }

    // Update all tickets
    const placeholders = ticket_ids.map((_, index) => `$${++paramCount}`).join(',');
    updateParams.push(...ticket_ids);

    const result = await client.query(
      `UPDATE tickets.tickets 
       SET ${updateFields.join(', ')}
       WHERE id IN (${placeholders})
       RETURNING *`,
      updateParams
    );

    // Add comments if provided
    if (comment) {
      for (const ticketId of ticket_ids) {
        await client.query(
          `INSERT INTO tickets.ticket_comments 
           (ticket_id, comment_text, created_by, created_by_type, is_internal)
           VALUES ($1, $2, $3, 'staff', true)`,
          [ticketId, comment, req.user.userId]
        );
      }
    }

    await client.query('COMMIT');

    try {
      await AuditService.log({
        userId: req.user.userId,
        userType: 'staff',
        actionType: AUDIT_LOG_TYPES.TICKET.ASSIGN,
        entityType: ENTITY_TYPES.TICKET,
        entityId: null,
        newValues: {
          action: 'bulk_assign',
          ticket_ids: ticket_ids,
          assigned_to: assigned_to,
          new_status: new_status,
          updated_count: result.rows.length,
          comment: comment || null
        },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });
    } catch (auditError) {
      console.error('Audit log failed:', auditError);
    }

    res.json({
      success: true,
      updated_count: result.rows.length,
      tickets: result.rows
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error bulk assigning tickets:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

// Bulk update status
router.post('/bulk-status', authenticate, staffOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { ticket_ids, new_status, comment, set_resolved_date, set_closed_date } = req.body;

    if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'ticket_ids array is required' 
      });
    }

    if (!new_status) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'new_status is required' 
      });
    }

    // Build update query
    let updateFields = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    let updateParams = [new_status];
    let paramCount = 1;

    if (new_status === 'resolved' && set_resolved_date) {
      updateFields.push('resolved_at = CURRENT_TIMESTAMP');
      updateFields.push(`resolved_by = $${++paramCount}`);
      updateParams.push(req.user.userId);
    }

    if (new_status === 'closed' && set_closed_date) {
      updateFields.push('closed_at = CURRENT_TIMESTAMP');
      updateFields.push(`closed_by = $${++paramCount}`);
      updateParams.push(req.user.userId);
    }

    // Update all tickets
    const placeholders = ticket_ids.map((_, index) => `$${++paramCount}`).join(',');
    updateParams.push(...ticket_ids);

    const result = await client.query(
      `UPDATE tickets.tickets 
       SET ${updateFields.join(', ')}
       WHERE id IN (${placeholders})
       RETURNING *`,
      updateParams
    );

    // Add comments if provided
    if (comment) {
      for (const ticketId of ticket_ids) {
        await client.query(
          `INSERT INTO tickets.ticket_comments 
           (ticket_id, comment_text, created_by, created_by_type, is_internal)
           VALUES ($1, $2, $3, 'staff', true)`,
          [ticketId, comment, req.user.userId]
        );
      }
    }

    await client.query('COMMIT');

    try {
      await AuditService.log({
        userId: req.user.userId,
        userType: 'staff',
        actionType: AUDIT_LOG_TYPES.TICKET.STATUS_CHANGE,
        entityType: ENTITY_TYPES.TICKET,
        entityId: null,
        newValues: {
          action: 'bulk_status_change',
          ticket_ids: ticket_ids,
          new_status: new_status,
          updated_count: result.rows.length,
          comment: comment || null,
          set_resolved_date,
          set_closed_date
        },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });
    } catch (auditError) {
      console.error('Audit log failed:', auditError);
    }

    res.json({
      success: true,
      updated_count: result.rows.length,
      tickets: result.rows
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error bulk updating status:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

// Bulk update priority
router.post('/bulk-priority', authenticate, staffOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { ticket_ids, new_priority, reason, custom_due_date } = req.body;

    if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'ticket_ids array is required' 
      });
    }

    if (!new_priority) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'new_priority is required' 
      });
    }

    // Build update query
    let updateFields = ['priority = $1', 'updated_at = CURRENT_TIMESTAMP'];
    let updateParams = [new_priority];
    let paramCount = 1;

    if (custom_due_date) {
      updateFields.push(`due_date = $${++paramCount}`);
      updateParams.push(custom_due_date);
    }

    // Update all tickets
    const placeholders = ticket_ids.map((_, index) => `$${++paramCount}`).join(',');
    updateParams.push(...ticket_ids);

    const result = await client.query(
      `UPDATE tickets.tickets 
       SET ${updateFields.join(', ')}
       WHERE id IN (${placeholders})
       RETURNING *`,
      updateParams
    );

    // Add reason as comment if provided
    if (reason) {
      for (const ticketId of ticket_ids) {
        await client.query(
          `INSERT INTO tickets.ticket_comments 
           (ticket_id, comment_text, created_by, created_by_type, is_internal)
           VALUES ($1, $2, $3, 'staff', true)`,
          [ticketId, `Priority changed to ${new_priority}: ${reason}`, req.user.userId]
        );
      }
    }

    await client.query('COMMIT');

    try {
      await AuditService.log({
        userId: req.user.userId,
        userType: 'staff',
        actionType: AUDIT_LOG_TYPES.TICKET.UPDATE,
        entityType: ENTITY_TYPES.TICKET,
        entityId: null,
        newValues: {
          action: 'bulk_priority_change',
          ticket_ids: ticket_ids,
          new_priority: new_priority,
          updated_count: result.rows.length,
          reason: reason || null,
          custom_due_date: custom_due_date || null
        },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });
    } catch (auditError) {
      console.error('Audit log failed:', auditError);
    }

    res.json({
      success: true,
      updated_count: result.rows.length,
      tickets: result.rows
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error bulk updating priority:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

router.get('/staff', authenticate, staffOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        u.id, 
        u.first_name, 
        u.last_name, 
        u.email,
        u.is_active,
        COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) as roles
       FROM auth.users u 
       LEFT JOIN auth.user_roles ur ON u.id = ur.user_id
       LEFT JOIN auth.roles r ON ur.role_id = r.id
       WHERE u.is_active = true
       GROUP BY u.id, u.first_name, u.last_name, u.email, u.is_active
       ORDER BY u.first_name, u.last_name`
    );

    const staff = result.rows.map(user => ({
      id: user.id,
      label: `${user.first_name} ${user.last_name}`,
      value: user.id,
      email: user.email,
      roles: user.roles || [],
      // Додаткова інформація для відображення навантаження
      department: (user.roles && user.roles.includes('admin')) ? 'Administration' : 'Support'
    }));

    res.json({
      success: true,
      staff
    });
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;