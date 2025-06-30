const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient } = require('../middleware/clientAccess');
const ChatService = require('../services/chatService');

// ===========================================
// CLIENT ENDPOINTS
// ===========================================

// Get active chat for client
router.get('/active', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const result = await ChatService.getActiveClientChat(req.user.clientId);
        
        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching active chat:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get chat rooms for client
router.get('/rooms', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const rooms = await ChatService.getClientRooms(req.user.clientId);
        
        res.json({
            success: true,
            rooms
        });
    } catch (error) {
        console.error('Error fetching chat rooms:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Create new chat room with active chat check
router.post('/rooms', authenticate, restrictToOwnData, async (req, res) => {
    const client = await pool.connect();
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        await client.query('BEGIN');

        const newRoom = await ChatService.createChatRoom(client, req.user.clientId, req.body);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            room: newRoom
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating chat room:', error);
        
        if (error.message === 'У вас вже є активний чат з підтримкою') {
            return res.status(400).json({ 
                success: false, 
                message: error.message
            });
        }
        
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// ===========================================
// SHARED ENDPOINTS (CLIENT & STAFF)
// ===========================================

// Get messages for a chat room
router.get('/rooms/:roomId/messages', authenticate, staffOrClient, async (req, res) => {
    try {
        const { roomId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        // Check access to room
        const roomAccess = await ChatService.checkRoomAccess(
            roomId, 
            req.user.userType, 
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!roomAccess) {
            return res.status(404).json({ success: false, message: 'Chat room not found' });
        }

        const result = await ChatService.getRoomMessages(roomId, page, limit);

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Send message to chat room
router.post('/rooms/:roomId/messages', authenticate, staffOrClient, async (req, res) => {
    const client = await pool.connect();
    try {
        const { roomId } = req.params;
        const { message_text } = req.body;

        if (!message_text || message_text.trim().length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Message text is required' 
            });
        }

        await client.query('BEGIN');

        // Check access to room
        const roomAccess = await ChatService.checkRoomAccess(
            roomId, 
            req.user.userType, 
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!roomAccess) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Chat room not found' });
        }

        // Determine sender info
        const senderId = req.user.userType === 'client' ? req.user.clientId : req.user.userId;
        const senderType = req.user.userType === 'client' ? 'client' : 'staff';

        const message = await ChatService.sendMessage(
            client, 
            roomId, 
            message_text, 
            senderId, 
            senderType
        );

        await client.query('COMMIT');

        // Real-time відправка повідомлення через Socket.io
        if (global.socketIO) {
            // Відправляємо в кімнату чату
            global.socketIO.emitToChatRoom(roomId, 'new_message', {
                message,
                room_id: roomId
            });

            // Якщо повідомлення від клієнта, сповіщаємо призначеного співробітника
            if (senderType === 'client' && roomAccess.assigned_staff_id) {
                global.socketIO.emitToUser(roomAccess.assigned_staff_id, 'new_chat_notification', {
                    room_id: roomId,
                    message,
                    type: 'new_message'
                });
            }
        }

        res.status(201).json({
            success: true,
            message
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// Mark messages as read
router.patch('/rooms/:roomId/read', authenticate, staffOrClient, async (req, res) => {
    try {
        const { roomId } = req.params;

        // Check access to room
        const roomAccess = await ChatService.checkRoomAccess(
            roomId, 
            req.user.userType, 
            req.user.userType === 'client' ? req.user.clientId : null
        );

        if (!roomAccess) {
            return res.status(404).json({ success: false, message: 'Chat room not found' });
        }

        await ChatService.markMessagesAsRead(roomId, req.user.userType);

        res.json({
            success: true,
            message: 'Messages marked as read'
        });
    } catch (error) {
        console.error('Error marking messages as read:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get staff status (for clients)
router.get('/staff-status', authenticate, async (req, res) => {
    try {
        const staff = await ChatService.getStaffStatus();
        
        res.json({
            success: true,
            staff
        });
    } catch (error) {
        console.error('Error fetching staff status:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ===========================================
// STAFF ONLY ENDPOINTS
// ===========================================

// Close chat room (staff only)
router.patch('/rooms/:roomId/close', authenticate, staffOrClient, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        if (req.user.userType !== 'staff') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const room = await ChatService.closeChatRoom(roomId, req.user.userId);

        if (!room) {
            return res.status(404).json({ success: false, message: 'Chat room not found' });
        }

        res.json({
            success: true,
            room
        });
    } catch (error) {
        console.error('Error closing chat room:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Assign chat to staff member
router.patch('/rooms/:roomId/assign', authenticate, staffOrClient, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { staffId } = req.body;
        
        if (req.user.userType !== 'staff') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const room = await ChatService.assignChatRoom(roomId, staffId);

        if (!room) {
            return res.status(404).json({ success: false, message: 'Chat room not found' });
        }

        // Real-time сповіщення про призначення
        if (global.socketIO) {
            global.socketIO.emitToUser(staffId, 'chat_assigned', {
                room_id: roomId,
                message: 'Вам призначено новий чат'
            });
        }

        res.json({
            success: true,
            room
        });
    } catch (error) {
        console.error('Error assigning chat room:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Delete chat room (staff only)
router.delete('/rooms/:roomId', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { roomId } = req.params;

        const deletedRoom = await ChatService.deleteChatRoom(client, roomId);

        await client.query('COMMIT');

        // Real-time notification about chat deletion
        if (global.socketIO) {
            global.socketIO.emitToChatRoom(roomId, 'chat_deleted', {
                room_id: roomId,
                message: 'Chat has been deleted by staff'
            });
        }

        res.json({
            success: true,
            message: 'Chat room deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting chat room:', error);
        
        if (error.message === 'Chat room not found') {
            return res.status(404).json({ success: false, message: error.message });
        }
        
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// Get all chat rooms for staff (with filters and pagination)
router.get('/staff/rooms', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await ChatService.getStaffRooms(req.query, page, limit);

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching staff chat rooms:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get chat metrics for staff dashboard
router.get('/staff/metrics', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    try {
        const result = await ChatService.getChatMetrics();

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching chat metrics:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Bulk assign chats
router.post('/staff/bulk-assign', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { room_ids, assigned_to } = req.body;

        if (!room_ids || !Array.isArray(room_ids) || room_ids.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false, 
                message: 'room_ids array is required' 
            });
        }

        const updatedRooms = await ChatService.bulkAssignRooms(client, room_ids, assigned_to);

        await client.query('COMMIT');

        res.json({
            success: true,
            updated_count: updatedRooms.length,
            rooms: updatedRooms
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error bulk assigning chats:', error);
        
        if (error.message === 'Staff member not found') {
            return res.status(400).json({ success: false, message: error.message });
        }
        
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// Bulk close chats
router.post('/staff/bulk-close', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { room_ids, close_reason } = req.body;

        if (!room_ids || !Array.isArray(room_ids) || room_ids.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false, 
                message: 'room_ids array is required' 
            });
        }

        const closedRooms = await ChatService.bulkCloseRooms(
            client, 
            room_ids, 
            req.user.userId, 
            close_reason
        );

        await client.query('COMMIT');

        // Real-time сповіщення про закриття чатів
        if (global.socketIO) {
            closedRooms.forEach(room => {
                global.socketIO.emitToChatRoom(room.id, 'chat_closed', {
                    room_id: room.id,
                    message: 'Chat has been closed by staff',
                    reason: close_reason
                });
            });
        }

        res.json({
            success: true,
            closed_count: closedRooms.length,
            rooms: closedRooms,
            message: `Successfully closed ${closedRooms.length} chat(s)`
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error bulk closing chats:', error);
        
        if (error.message === 'No active rooms found with provided IDs') {
            return res.status(400).json({ success: false, message: error.message });
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Server error',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        client.release();
    }
});

// Search in chats and messages
router.get('/staff/search', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    try {
        const { query, search_type = 'all', limit = 20 } = req.query;

        const result = await ChatService.searchChats(query, search_type, limit);

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error searching chats:', error);
        
        if (error.message === 'Search query must be at least 2 characters') {
            return res.status(400).json({ success: false, message: error.message });
        }
        
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get specific chat room by ID for staff
router.get('/staff/rooms/:roomId', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    try {
        const { roomId } = req.params;

        const room = await ChatService.getStaffRoomById(roomId);

        if (!room) {
            return res.status(404).json({ success: false, message: 'Chat room not found' });
        }

        res.json({
            success: true,
            room
        });
    } catch (error) {
        console.error('Error fetching specific chat room:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get available staff for assignment
router.get('/staff/available', authenticate, async (req, res) => {
    if (req.user.userType !== 'staff') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    try {
        const staff = await ChatService.getAvailableStaff();

        res.json({
            success: true,
            staff
        });
    } catch (error) {
        console.error('Error fetching available staff:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;