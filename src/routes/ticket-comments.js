const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { staffOrClient } = require('../middleware/clientAccess');
const AuditService = require('../services/auditService');
const TicketCommentsService = require('../services/ticketCommentsService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get comments for a ticket
router.get('/ticket/:ticketId', authenticate, staffOrClient, async (req, res) => {
    try {
        const { ticketId } = req.params;

        // Check if user has access to this ticket
        const ticketAccess = await TicketCommentsService.checkTicketAccess(
            ticketId,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!ticketAccess) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const comments = await TicketCommentsService.getTicketComments(ticketId, req.user.userType);

        res.json({
            success: true,
            comments
        });
    } catch (error) {
        console.error('Error fetching ticket comments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Add comment to ticket
router.post('/ticket/:ticketId', authenticate, staffOrClient, async (req, res) => {
    const client = await pool.connect();
    try {
        const { ticketId } = req.params;
        const { comment_text, is_internal = false } = req.body;

        if (!comment_text || comment_text.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Comment text is required' });
        }

        await client.query('BEGIN');

        // Check if user has access to this ticket
        const ticketAccess = await TicketCommentsService.checkTicketAccess(
            ticketId,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!ticketAccess) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const comment = await TicketCommentsService.createComment(
            client,
            ticketId,
            comment_text,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : req.user.userId,
            is_internal
        );

        await client.query('COMMIT');

        // Audit log for both staff and clients
        try {
            console.log('=== AUDIT LOG DEBUG ===');
            console.log('User type:', req.user.userType);
            console.log('Comment data:', comment);
            
            if (req.user.userType === 'staff') {
                console.log('Logging as STAFF with actionType:', AUDIT_LOG_TYPES.CLIENT_PORTAL.ADD_COMMENT);
                
                await AuditService.log({
                    userId: req.user.userId,
                    userType: 'staff',
                    actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.ADD_COMMENT,
                    entityType: ENTITY_TYPES.TICKET_COMMENT,
                    entityId: comment.id,
                    newValues: {
                        ticket_id: ticketId,
                        comment_text: comment.comment_text,
                        is_internal: comment.is_internal,
                        comment_id: comment.id,
                        created_by: comment.created_by,
                        created_by_type: comment.created_by_type
                    },
                    ipAddress: req.ip,
                    auditType: AUDIT_TYPES.BUSINESS,
                    req
                });
                
                console.log('✓ Staff audit log successful');
            } else {
                console.log('Logging as CLIENT with actionType:', AUDIT_LOG_TYPES.CLIENT_PORTAL.ADD_COMMENT);
                
                await AuditService.log({
                    clientId: req.user.clientId,
                    userType: 'client', 
                    actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.ADD_COMMENT,
                    entityType: ENTITY_TYPES.TICKET_COMMENT,
                    entityId: comment.id,
                    newValues: {
                        ticket_id: ticketId,
                        comment_text: comment.comment_text,
                        comment_id: comment.id,
                        client_id: req.user.clientId,
                        created_by: comment.created_by,
                        created_by_type: comment.created_by_type
                    },
                    ipAddress: req.ip,
                    auditType: AUDIT_TYPES.BUSINESS,
                    req
                });
                
                console.log('✓ Client audit log successful');
            }
        } catch (auditError) {
            console.error('❌ Audit log failed:', auditError);
            console.error('Error details:', {
                message: auditError.message,
                stack: auditError.stack
            });
        }

        // Real-time сповіщення про новий коментар через Socket.io
        if (global.socketIO) {
            global.socketIO.emitTicketCommentAdded(ticketId, comment);
            console.log(`✅ Emitted ticket comment added for ticket ${ticketId}`);
        }

        res.status(201).json({
            success: true,
            comment
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating ticket comment:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
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

        const comment = await TicketCommentsService.updateComment(
            id,
            comment_text,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : req.user.userId
        );

        if (!comment) {
            return res.status(404).json({ success: false, message: 'Comment not found or access denied' });
        }

        // Audit log
        try {
            console.log('=== UPDATE COMMENT AUDIT LOG ===');
            console.log('User type:', req.user.userType);
            
            if (req.user.userType === 'staff') {
                await AuditService.log({
                    userId: req.user.userId,
                    userType: 'staff',
                    actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.UPDATE_COMMENT,
                    entityType: ENTITY_TYPES.TICKET_COMMENT,
                    entityId: id,
                    newValues: {
                        comment_id: id,
                        comment_text: comment.comment_text,
                        updated_at: comment.updated_at
                    },
                    ipAddress: req.ip,
                    auditType: AUDIT_TYPES.BUSINESS,
                    req
                });
            } else {
                await AuditService.log({
                    clientId: req.user.clientId,
                    userType: 'client',
                    actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.UPDATE_COMMENT,
                    entityType: ENTITY_TYPES.TICKET_COMMENT,
                    entityId: id,
                    newValues: {
                        comment_id: id,
                        comment_text: comment.comment_text,
                        updated_at: comment.updated_at,
                        client_id: req.user.clientId
                    },
                    ipAddress: req.ip,
                    auditType: AUDIT_TYPES.BUSINESS,
                    req
                });
            }
        } catch (auditError) {
            console.error('Update comment audit log failed:', auditError);
        }

        // Real-time сповіщення про оновлення коментаря через Socket.io
        if (global.socketIO) {
            global.socketIO.emitToTicketRoom(comment.ticket_id, 'ticket_comment_updated', {
                ticket_id: comment.ticket_id,
                comment: comment
            });
        }

        res.json({
            success: true,
            comment
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

        const comment = await TicketCommentsService.deleteComment(
            id,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : req.user.userId
        );

        if (!comment) {
            return res.status(404).json({ success: false, message: 'Comment not found or access denied' });
        }

        // Audit log
        try {
            console.log('=== DELETE COMMENT AUDIT LOG ===');
            console.log('User type:', req.user.userType);
            
            if (req.user.userType === 'staff') {
                await AuditService.log({
                    userId: req.user.userId,
                    userType: 'staff',
                    actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.DELETE_COMMENT,
                    entityType: ENTITY_TYPES.TICKET_COMMENT,
                    entityId: id,
                    oldValues: {
                        comment_id: id,
                        comment_text: comment.comment_text,
                        ticket_id: comment.ticket_id,
                        created_by: comment.created_by,
                        created_by_type: comment.created_by_type
                    },
                    ipAddress: req.ip,
                    auditType: AUDIT_TYPES.BUSINESS,
                    req
                });
                console.log('✓ Staff delete audit log successful');
            } else {
                await AuditService.log({
                    clientId: req.user.clientId,
                    userType: 'client',
                    actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.DELETE_COMMENT,
                    entityType: ENTITY_TYPES.TICKET_COMMENT,
                    entityId: id,
                    oldValues: {
                        comment_id: id,
                        comment_text: comment.comment_text,
                        ticket_id: comment.ticket_id,
                        client_id: req.user.clientId
                    },
                    ipAddress: req.ip,
                    auditType: AUDIT_TYPES.BUSINESS,
                    req
                });
                console.log('✓ Client delete audit log successful');
            }
        } catch (auditError) {
            console.error('❌ Delete comment audit log failed:', auditError);
        }

        // Real-time сповіщення про видалення коментаря через Socket.io
        if (global.socketIO) {
            global.socketIO.emitToTicketRoom(comment.ticket_id, 'ticket_comment_deleted', {
                ticket_id: comment.ticket_id,
                comment_id: id
            });
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

// Get comments with edit permissions
router.get('/ticket/:ticketId/editable', authenticate, staffOrClient, async (req, res) => {
    try {
        const { ticketId } = req.params;

        // Check if user has access to this ticket
        const ticketAccess = await TicketCommentsService.checkTicketAccess(
            ticketId,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!ticketAccess) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const comments = await TicketCommentsService.getEditableComments(
            ticketId,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : req.user.userId
        );

        res.json({
            success: true,
            comments
        });
    } catch (error) {
        console.error('Error fetching editable comments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get comment statistics for ticket
router.get('/ticket/:ticketId/stats', authenticate, staffOrClient, async (req, res) => {
    try {
        const { ticketId } = req.params;

        // Check if user has access to this ticket
        const ticketAccess = await TicketCommentsService.checkTicketAccess(
            ticketId,
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!ticketAccess) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const stats = await TicketCommentsService.getTicketCommentsStats(ticketId, req.user.userType);

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error fetching comment stats:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Search comments
router.get('/search', authenticate, staffOrClient, async (req, res) => {
    try {
        const { q: searchTerm, limit = 50 } = req.query;

        if (!searchTerm || searchTerm.trim().length < 2) {
            return res.status(400).json({
                success: false,
                message: 'Search term must be at least 2 characters'
            });
        }

        const comments = await TicketCommentsService.searchComments(
            searchTerm.trim(),
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : null,
            parseInt(limit)
        );

        res.json({
            success: true,
            comments,
            query: searchTerm.trim()
        });
    } catch (error) {
        console.error('Error searching comments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get user's recent comments
router.get('/user/recent', authenticate, staffOrClient, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        const comments = await TicketCommentsService.getUserRecentComments(
            req.user.userType,
            req.user.userType === 'client' ? req.user.clientId : req.user.userId,
            limit
        );

        res.json({
            success: true,
            comments
        });
    } catch (error) {
        console.error('Error fetching user recent comments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Bulk delete comments (staff only)
router.delete('/bulk', authenticate, async (req, res) => {
    try {
        if (req.user.userType !== 'staff') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { comment_ids } = req.body;

        if (!comment_ids || !Array.isArray(comment_ids) || comment_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'comment_ids array is required'
            });
        }

        const deletedComments = await TicketCommentsService.bulkDeleteComments(comment_ids, req.user.userId);

        // Audit log
        try {
            await AuditService.log({
                userId: req.user.userId,
                userType: 'staff',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.DELETE_COMMENT,
                entityType: ENTITY_TYPES.TICKET_COMMENT,
                entityId: null,
                oldValues: {
                    action: 'bulk_delete',
                    comment_ids: comment_ids,
                    deleted_count: deletedComments.length,
                    deleted_comments: deletedComments
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Bulk delete audit log failed:', auditError);
        }

        res.json({
            success: true,
            deleted_count: deletedComments.length,
            message: `Successfully deleted ${deletedComments.length} comment(s)`
        });
    } catch (error) {
        console.error('Error bulk deleting comments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;