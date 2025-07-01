const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient, staffOnly } = require('../middleware/clientAccess');
const AuditService = require('../services/auditService');
const TicketService = require('../services/ticketService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get staff list
router.get('/staff', authenticate, staffOnly, async (req, res) => {
    try {
        const staff = await TicketService.getStaffList();
        
        res.json({
            success: true,
            staff
        });
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Dashboard metrics routes
router.get('/metrics', authenticate, staffOnly, async (req, res) => {
    try {
        const metrics = await TicketService.getTicketsMetrics();
        
        res.json({
            success: true,
            metrics
        });
    } catch (error) {
        console.error('Error fetching tickets metrics:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get tickets status distribution for chart
router.get('/status-distribution', authenticate, staffOnly, async (req, res) => {
    try {
        const distribution = await TicketService.getStatusDistribution();
        
        res.json({
            success: true,
            distribution
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
        const tickets = await TicketService.getRecentTickets(limit);
        
        res.json({
            success: true,
            tickets
        });
    } catch (error) {
        console.error('Error fetching recent tickets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get tickets by category statistics
router.get('/by-category', authenticate, staffOnly, async (req, res) => {
    try {
        const categories = await TicketService.getTicketsByCategory();
        
        res.json({
            success: true,
            categories
        });
    } catch (error) {
        console.error('Error fetching tickets by category:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get ticket categories
router.get('/categories', authenticate, staffOrClient, async (req, res) => {
    try {
        const categories = await TicketService.getTicketCategories();
        
        res.json({
            success: true,
            categories
        });
    } catch (error) {
        console.error('Error fetching ticket categories:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Bulk assign tickets
router.post('/bulk-assign', authenticate, staffOnly, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { ticket_ids, assigned_to, comment } = req.body;

        const updatedTickets = await TicketService.bulkAssignTickets(
            client,
            ticket_ids,
            assigned_to,
            comment,
            req.user.userId
        );

        await client.query('COMMIT');

        // Audit log
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
                    updated_count: updatedTickets.length,
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
            updated_count: updatedTickets.length,
            tickets: updatedTickets
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error bulk assigning tickets:', error);
        
        if (error.message.includes('required')) {
            return res.status(400).json({ success: false, message: error.message });
        }
        
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

        const updatedTickets = await TicketService.bulkUpdateStatus(
            client,
            ticket_ids,
            new_status,
            comment,
            req.user.userId,
            { set_resolved_date, set_closed_date }
        );

        await client.query('COMMIT');

        // Audit log
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
                    updated_count: updatedTickets.length,
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
            updated_count: updatedTickets.length,
            tickets: updatedTickets
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error bulk updating status:', error);
        
        if (error.message.includes('required')) {
            return res.status(400).json({ success: false, message: error.message });
        }
        
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

        const updatedTickets = await TicketService.bulkUpdatePriority(
            client,
            ticket_ids,
            new_priority,
            reason,
            req.user.userId,
            custom_due_date
        );

        await client.query('COMMIT');

        // Audit log
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
                    updated_count: updatedTickets.length,
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
            updated_count: updatedTickets.length,
            tickets: updatedTickets
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error bulk updating priority:', error);
        
        if (error.message.includes('required')) {
            return res.status(400).json({ success: false, message: error.message });
        }
        
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// Get tickets
router.get('/', authenticate, staffOrClient, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const result = await TicketService.getTickets(
            req.query,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : null,
            page,
            limit
        );

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching tickets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get single ticket
router.get('/:id', authenticate, staffOrClient, async (req, res) => {
    try {
        const ticket = await TicketService.getTicketById(
            req.params.id,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        res.json({
            success: true,
            ticket
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

        const { title, description } = req.body;

        // Validate required fields
        if (!title || !description) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false, 
                message: 'Title and description are required' 
            });
        }

        const ticket = await TicketService.createTicket(
            client,
            req.body,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : req.user.userId
        );

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
        
        if (error.message.includes('not found') || error.message.includes('required')) {
            return res.status(400).json({ success: false, message: error.message });
        }
        
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// Update ticket (staff only for status changes)
router.put('/:id', authenticate, staffOnly, async (req, res) => {
    try {
        const ticket = await TicketService.updateTicket(req.params.id, req.body, req.user.userId);

        if (!ticket) {
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
                    status: ticket.status,
                    priority: ticket.priority,
                    assigned_to: ticket.assigned_to,
                    category_id: ticket.category_id,
                    updated_by: req.user.userId,
                    updated_at: ticket.updated_at
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        // Real-time сповіщення про оновлення заявки через Socket.io
        if (global.socketIO) {
            global.socketIO.emitTicketUpdate(req.params.id, ticket);
            console.log(`✅ Emitted ticket update for ticket ${req.params.id}`);
        }

        res.json({
            success: true,
            ticket
        });
    } catch (error) {
        console.error('Error updating ticket:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;