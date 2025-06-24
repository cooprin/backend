const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { staffOrClient } = require('../middleware/clientAccess');
const AuditService = require('../services/auditService');
const { AUDIT_TYPES } = require('../constants/constants');

// Get comments for a ticket
router.get('/ticket/:ticketId', authenticate, staffOrClient, async (req, res) => {
  try {
    const { ticketId } = req.params;

    // Check if user has access to this ticket
    let ticketQuery, ticketParams;
    if (req.user.userType === 'client') {
      ticketQuery = 'SELECT id FROM tickets.tickets WHERE id = $1 AND client_id = $2';
      ticketParams = [ticketId, req.user.clientId];
    } else {
      ticketQuery = 'SELECT id FROM tickets.tickets WHERE id = $1';
      ticketParams = [ticketId];
    }

    const ticketCheck = await pool.query(ticketQuery, ticketParams);
    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Get comments (filter internal comments for clients)
    let commentsQuery = `
      SELECT 
        tc.id, tc.comment_text, tc.is_internal, tc.created_by, tc.created_by_type, tc.created_at,
        CASE 
          WHEN tc.created_by_type = 'client' THEN c.name
          WHEN tc.created_by_type = 'staff' THEN u.first_name || ' ' || u.last_name
        END as author_name
      FROM tickets.ticket_comments tc
      LEFT JOIN clients.clients c ON (tc.created_by_type = 'client' AND tc.created_by = c.id)
      LEFT JOIN auth.users u ON (tc.created_by_type = 'staff' AND tc.created_by = u.id)
      WHERE tc.ticket_id = $1`;

    // Hide internal comments from clients
    if (req.user.userType === 'client') {
      commentsQuery += ' AND tc.is_internal = false';
    }

    commentsQuery += ' ORDER BY tc.created_at ASC';

    const result = await pool.query(commentsQuery, [ticketId]);

    res.json({
      success: true,
      comments: result.rows
    });
  } catch (error) {
    console.error('Error fetching ticket comments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add comment to ticket
router.post('/ticket/:ticketId', authenticate, staffOrClient, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { comment_text, is_internal = false } = req.body;

    if (!comment_text || comment_text.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }

    // Check if user has access to this ticket
    let ticketQuery, ticketParams;
    if (req.user.userType === 'client') {
      ticketQuery = 'SELECT id FROM tickets.tickets WHERE id = $1 AND client_id = $2';
      ticketParams = [ticketId, req.user.clientId];
    } else {
      ticketQuery = 'SELECT id FROM tickets.tickets WHERE id = $1';
      ticketParams = [ticketId];
    }

    const ticketCheck = await pool.query(ticketQuery, ticketParams);
    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Determine comment creator
    let createdBy, createdByType, finalIsInternal;
    
    if (req.user.userType === 'client') {
      createdBy = req.user.clientId;
      createdByType = 'client';
      finalIsInternal = false; // Clients can't create internal comments
    } else {
      createdBy = req.user.userId;
      createdByType = 'staff';
      finalIsInternal = is_internal;
    }

    const result = await pool.query(
      `INSERT INTO tickets.ticket_comments 
       (ticket_id, comment_text, is_internal, created_by, created_by_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ticketId, comment_text.trim(), finalIsInternal, createdBy, createdByType]
    );

    const comment = result.rows[0];

    // Get author name for response
    let authorName;
    if (createdByType === 'client') {
      const clientResult = await pool.query('SELECT name FROM clients.clients WHERE id = $1', [createdBy]);
      authorName = clientResult.rows[0]?.name;
    } else {
      const userResult = await pool.query('SELECT first_name, last_name FROM auth.users WHERE id = $1', [createdBy]);
      const user = userResult.rows[0];
      authorName = user ? `${user.first_name} ${user.last_name}` : null;
    }

    // Update ticket status if needed
    if (req.user.userType === 'client') {
      // If client adds comment and ticket is "waiting_client", change to "open"
      await pool.query(
        `UPDATE tickets.tickets 
         SET status = CASE WHEN status = 'waiting_client' THEN 'open' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [ticketId]
      );
    }

    // Audit log only for staff actions
    if (req.user.userType === 'staff') {
      try {
        await AuditService.log({
          userId: req.user.userId,
          actionType: 'TICKET_COMMENT_CREATE',
          entityType: 'TICKET_COMMENT',
          entityId: comment.id,
          newValues: comment,
          ipAddress: req.ip,
          auditType: AUDIT_TYPES.BUSINESS,
          req
        });
      } catch (auditError) {
        console.error('Audit log failed:', auditError);
        // Don't fail the request if audit fails
      }
    }

    res.status(201).json({
      success: true,
      comment: {
        ...comment,
        author_name: authorName
      }
    });
  } catch (error) {
    console.error('Error creating ticket comment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update comment (only by author or staff)
router.put('/:id', authenticate, staffOrClient, async (req, res) => {
  try {
    const { id } = req.params;
    const { comment_text } = req.body;

    if (!comment_text || comment_text.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }

    // Check if user can edit this comment
    let whereClause = 'WHERE tc.id = $1';
    let queryParams = [id];

    if (req.user.userType === 'client') {
      whereClause += ' AND tc.created_by = $2 AND tc.created_by_type = $3';
      queryParams.push(req.user.clientId, 'client');
    }
    // Staff can edit any comment

    const result = await pool.query(
      `UPDATE tickets.ticket_comments tc
       SET comment_text = $${queryParams.length + 1}, updated_at = CURRENT_TIMESTAMP
       ${whereClause}
       RETURNING *`,
      [...queryParams, comment_text.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Comment not found or access denied' });
    }

    // Audit log only for staff actions
    if (req.user.userType === 'staff') {
      try {
        await AuditService.log({
          userId: req.user.userId,
          actionType: 'TICKET_COMMENT_UPDATE',
          entityType: 'TICKET_COMMENT',
          entityId: id,
          newValues: result.rows[0],
          ipAddress: req.ip,
          auditType: AUDIT_TYPES.BUSINESS,
          req
        });
      } catch (auditError) {
        console.error('Audit log failed:', auditError);
        // Don't fail the request if audit fails
      }
    }

    res.json({
      success: true,
      comment: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating ticket comment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete comment (only by author or staff)
router.delete('/:id', authenticate, staffOrClient, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user can delete this comment
    let whereClause = 'WHERE id = $1';
    let queryParams = [id];

    if (req.user.userType === 'client') {
      whereClause += ' AND created_by = $2 AND created_by_type = $3';
      queryParams.push(req.user.clientId, 'client');
    }
    // Staff can delete any comment

    const result = await pool.query(
      `DELETE FROM tickets.ticket_comments ${whereClause} RETURNING *`,
      queryParams
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Comment not found or access denied' });
    }

    // Audit log only for staff actions
    if (req.user.userType === 'staff') {
      try {
        await AuditService.log({
          userId: req.user.userId,
          actionType: 'TICKET_COMMENT_DELETE',
          entityType: 'TICKET_COMMENT',
          entityId: id,
          oldValues: result.rows[0],
          ipAddress: req.ip,
          auditType: AUDIT_TYPES.BUSINESS,
          req
        });
      } catch (auditError) {
        console.error('Audit log failed:', auditError);
        // Don't fail the request if audit fails
      }
    }

    res.json({
      success: true,
      message: 'Comment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting ticket comment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;