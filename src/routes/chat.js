const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient } = require('../middleware/clientAccess');

router.use(express.urlencoded({ extended: true }));

// NEW: Get active chat for client
router.get('/active', authenticate, restrictToOwnData, async (req, res) => {
  try {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT 
        cr.id, cr.client_id, cr.ticket_id, cr.room_type, cr.assigned_staff_id,
        cr.room_status, cr.last_message_at, cr.created_at,
        t.ticket_number, t.title as ticket_title,
        u.first_name || ' ' || u.last_name as assigned_staff_name,
        COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'staff') as unread_staff_messages
      FROM chat.chat_rooms cr
      LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
      LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
      LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
      WHERE cr.client_id = $1 AND cr.room_status = 'active'
      GROUP BY cr.id, t.ticket_number, t.title, u.first_name, u.last_name
      ORDER BY cr.last_message_at DESC NULLS LAST, cr.created_at DESC
      LIMIT 1`,
      [req.user.clientId]
    );

    res.json({
      success: true,
      activeRoom: result.rows.length > 0 ? result.rows[0] : null,
      hasActiveChat: result.rows.length > 0
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

    const result = await pool.query(
      `SELECT 
        cr.id, cr.client_id, cr.ticket_id, cr.room_type, cr.assigned_staff_id,
        cr.room_status, cr.last_message_at, cr.created_at,
        t.ticket_number, t.title as ticket_title,
        u.first_name || ' ' || u.last_name as assigned_staff_name,
        COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'staff') as unread_staff_messages
      FROM chat.chat_rooms cr
      LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
      LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
      LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
      WHERE cr.client_id = $1
      GROUP BY cr.id, t.ticket_number, t.title, u.first_name, u.last_name
      ORDER BY cr.last_message_at DESC NULLS LAST, cr.created_at DESC`,
      [req.user.clientId]
    );

    res.json({
      success: true,
      rooms: result.rows
    });
  } catch (error) {
    console.error('Error fetching chat rooms:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// MODIFIED: Create new chat room with active chat check
router.post('/rooms', authenticate, restrictToOwnData, async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { room_type = 'support', ticket_id } = req.body;

    await client.query('BEGIN');

    // Check if client already has an active chat
    const existingChatCheck = await client.query(
      'SELECT id FROM chat.chat_rooms WHERE client_id = $1 AND room_status = $2',
      [req.user.clientId, 'active']
    );

    if (existingChatCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'У вас вже є активний чат з підтримкою',
        existingRoomId: existingChatCheck.rows[0].id
      });
    }

    // Validate ticket belongs to client if specified
    if (ticket_id) {
      const ticketCheck = await client.query(
        'SELECT id FROM tickets.tickets WHERE id = $1 AND client_id = $2',
        [ticket_id, req.user.clientId]
      );
      
      if (ticketCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          success: false, 
          message: 'Ticket not found or access denied' 
        });
      }
    }

    const result = await client.query(
      `INSERT INTO chat.chat_rooms (client_id, ticket_id, room_type, room_status)
       VALUES ($1, $2, $3, 'active')
       RETURNING *`,
      [req.user.clientId, ticket_id, room_type]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      room: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating chat room:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

// Get messages for a chat room
router.get('/rooms/:roomId/messages', authenticate, staffOrClient, async (req, res) => {
  try {
    const { roomId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // Check access to room
    let roomCheck;
    if (req.user.userType === 'client') {
      roomCheck = await pool.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1 AND client_id = $2',
        [roomId, req.user.clientId]
      );
    } else {
      roomCheck = await pool.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1',
        [roomId]
      );
    }

    if (roomCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    // Get messages
const messagesQuery = `
  SELECT 
    cm.id, cm.room_id, cm.message_text, cm.sender_id, cm.sender_type,
    cm.is_read, cm.read_at, cm.external_platform, cm.created_at,
    CASE 
      WHEN cm.sender_type = 'client' THEN c.name
      WHEN cm.sender_type = 'staff' THEN u.first_name || ' ' || u.last_name
    END as sender_name
  FROM chat.chat_messages cm
  LEFT JOIN clients.clients c ON (cm.sender_type = 'client' AND cm.sender_id = c.id)
  LEFT JOIN auth.users u ON (cm.sender_type = 'staff' AND cm.sender_id = u.id)
  WHERE cm.room_id = $1
  ORDER BY cm.created_at ASC
  LIMIT $2 OFFSET $3
`;

    const result = await pool.query(messagesQuery, [roomId, limit, offset]);

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM chat.chat_messages WHERE room_id = $1',
      [roomId]
    );

    res.json({
      success: true,
      messages: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
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
    console.log('Raw body:', req.body);
console.log('Message text:', message_text);
console.log('Content-Type:', req.headers['content-type']);

    if (!message_text || message_text.trim().length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Message text is required' 
      });
    }

    await client.query('BEGIN');

    // Check access to room
    let roomCheck;
    if (req.user.userType === 'client') {
      roomCheck = await client.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1 AND client_id = $2',
        [roomId, req.user.clientId]
      );
    } else {
      roomCheck = await client.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1',
        [roomId]
      );
    }

    if (roomCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    // Determine sender info
    let senderId, senderType;
    if (req.user.userType === 'client') {
      senderId = req.user.clientId;
      senderType = 'client';
    } else {
      senderId = req.user.userId;
      senderType = 'staff';
    }

    // Insert message
    const messageResult = await client.query(
      `INSERT INTO chat.chat_messages (room_id, message_text, sender_id, sender_type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [roomId, message_text.trim(), senderId, senderType]
    );

    const message = messageResult.rows[0];


    // Update room last message time
    await client.query(
      'UPDATE chat.chat_rooms SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1',
      [roomId]
    );

    await client.query('COMMIT');

    // Get sender name for response
    let senderName;
    if (senderType === 'client') {
      const clientResult = await client.query('SELECT name FROM clients.clients WHERE id = $1', [senderId]);
      senderName = clientResult.rows[0]?.name;
    } else {
      const userResult = await client.query('SELECT first_name, last_name FROM auth.users WHERE id = $1', [senderId]);
      const user = userResult.rows[0];
      senderName = user ? `${user.first_name} ${user.last_name}` : null;
    }

    // Real-time відправка повідомлення через Socket.io
    if (global.socketIO) {
        const messageData = {
          ...message,
          sender_name: senderName
        };

      // Відправляємо в кімнату чату
      global.socketIO.emitToChatRoom(roomId, 'new_message', {
        message: messageData,
        room_id: roomId
      });

      // Якщо повідомлення від клієнта, сповіщаємо призначеного співробітника
      if (senderType === 'client') {
        const roomInfo = await client.query(
          'SELECT assigned_staff_id FROM chat.chat_rooms WHERE id = $1',
          [roomId]
        );
        
        if (roomInfo.rows[0]?.assigned_staff_id) {
          global.socketIO.emitToUser(roomInfo.rows[0].assigned_staff_id, 'new_chat_notification', {
            room_id: roomId,
            message: messageData,
            type: 'new_message'
          });
        }
      }
    }

      res.status(201).json({
        success: true,
        message: {
          ...message,
          sender_name: senderName
        }
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
    let roomCheck;
    if (req.user.userType === 'client') {
      roomCheck = await pool.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1 AND client_id = $2',
        [roomId, req.user.clientId]
      );
    } else {
      roomCheck = await pool.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1',
        [roomId]
      );
    }

    if (roomCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    // Mark messages as read based on user type
    let updateQuery;
    let queryParams;

    if (req.user.userType === 'client') {
      // Client marks staff messages as read
      updateQuery = `
        UPDATE chat.chat_messages 
        SET is_read = true, read_at = CURRENT_TIMESTAMP
        WHERE room_id = $1 AND sender_type = 'staff' AND is_read = false
      `;
      queryParams = [roomId];
    } else {
      // Staff marks client messages as read
      updateQuery = `
        UPDATE chat.chat_messages 
        SET is_read = true, read_at = CURRENT_TIMESTAMP
        WHERE room_id = $1 AND sender_type = 'client' AND is_read = false
      `;
      queryParams = [roomId];
    }

    await pool.query(updateQuery, queryParams);

    res.json({
      success: true,
      message: 'Messages marked as read'
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// Отримати статус онлайн для співробітників (для клієнтів)
router.get('/staff-status', authenticate, async (req, res) => {
  try {
    // Простий статус - в реальності тут буде WebSocket логіка
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, 
              false as is_online, 
              CURRENT_TIMESTAMP - INTERVAL '5 minutes' as last_seen
       FROM auth.users u
       JOIN auth.user_roles ur ON u.id = ur.user_id
       JOIN auth.role_permissions rp ON ur.role_id = rp.role_id
       JOIN auth.permissions p ON rp.permission_id = p.id
       WHERE p.code = 'chat.read'
       AND u.is_active = true`
    );

    res.json({
      success: true,
      staff: result.rows
    });
  } catch (error) {
    console.error('Error fetching staff status:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Закриття чат-кімнати (тільки для співробітників)
router.patch('/rooms/:roomId/close', authenticate, staffOrClient, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    if (req.user.userType !== 'staff') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await pool.query(
      `UPDATE chat.chat_rooms 
       SET room_status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = $1
       WHERE id = $2
       RETURNING *`,
      [req.user.userId, roomId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    res.json({
      success: true,
      room: result.rows[0]
    });
  } catch (error) {
    console.error('Error closing chat room:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Призначення чату співробітнику
router.patch('/rooms/:roomId/assign', authenticate, staffOrClient, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { staffId } = req.body;
    
    if (req.user.userType !== 'staff') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await pool.query(
      `UPDATE chat.chat_rooms 
       SET assigned_staff_id = $1
       WHERE id = $2
       RETURNING *`,
      [staffId, roomId]
    );

    if (result.rows.length === 0) {
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
      room: result.rows[0]
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

    // Check if room exists
    const roomCheck = await client.query(
      'SELECT id, client_id FROM chat.chat_rooms WHERE id = $1',
      [roomId]
    );

    if (roomCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

     // Delete chat room (cascade will handle messages and files)
    await client.query('DELETE FROM chat.chat_rooms WHERE id = $1', [roomId]);

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
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

// ===========================================
// STAFF CHAT MANAGEMENT ENDPOINTS
// ===========================================

// Get all chat rooms for staff (with filters and pagination)
router.get('/staff/rooms', authenticate, async (req, res) => {
  if (req.user.userType !== 'staff') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    let queryParams = [];
    let paramCount = 0;

    // Status filter
    if (req.query.status) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `cr.room_status = $${++paramCount}`;
      queryParams.push(req.query.status);
    }

    // Room type filter
    if (req.query.room_type) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `cr.room_type = $${++paramCount}`;
      queryParams.push(req.query.room_type);
    }

    // Assigned staff filter
    if (req.query.assigned_to) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      if (req.query.assigned_to === 'unassigned') {
        whereClause += `cr.assigned_staff_id IS NULL`;
      } else {
        whereClause += `cr.assigned_staff_id = $${++paramCount}`;
        queryParams.push(req.query.assigned_to);
      }
    }

    // Client filter
    if (req.query.client_id) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `cr.client_id = $${++paramCount}`;
      queryParams.push(req.query.client_id);
    }

    // Search filter
    if (req.query.search) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `(c.name ILIKE $${++paramCount} OR t.title ILIKE $${++paramCount} OR t.ticket_number ILIKE $${++paramCount})`;
      const searchTerm = `%${req.query.search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }

    // Date filters
    if (req.query.created_from) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(cr.created_at) >= $${++paramCount}`;
      queryParams.push(req.query.created_from);
    }

    if (req.query.created_to) {
      whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
      whereClause += `DATE(cr.created_at) <= $${++paramCount}`;
      queryParams.push(req.query.created_to);
    }

    // Sorting
    let orderBy = 'ORDER BY cr.last_message_at DESC NULLS LAST, cr.created_at DESC';
    if (req.query.sortBy) {
      const allowedSortFields = ['created_at', 'last_message_at', 'client_name', 'room_status'];
      if (allowedSortFields.includes(req.query.sortBy)) {
        const direction = req.query.sortDesc === 'true' ? 'DESC' : 'ASC';
        if (req.query.sortBy === 'client_name') {
          orderBy = `ORDER BY c.name ${direction}`;
        } else {
          orderBy = `ORDER BY cr.${req.query.sortBy} ${direction}`;
        }
      }
    }

    // Add limit and offset
    queryParams.push(limit, offset);

    const roomsQuery = `
      SELECT 
        cr.*,
        c.name as client_name,
        c.email as client_email,
        t.ticket_number,
        t.title as ticket_title,
        t.status as ticket_status,
        u.first_name || ' ' || u.last_name as assigned_staff_name,
        u.email as assigned_staff_email,
        COUNT(cm.id) as total_messages,
        COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'client') as unread_client_messages,
        (
          SELECT json_build_object(
            'id', last_msg.id,
            'message_text', last_msg.message_text,
            'created_at', last_msg.created_at,
            'sender_type', last_msg.sender_type,
            'sender_name',
            CASE 
              WHEN last_msg.sender_type = 'client' THEN lm_client.name
              ELSE lm_user.first_name || ' ' || lm_user.last_name
            END
          )
          FROM chat.chat_messages last_msg
          LEFT JOIN clients.clients lm_client ON last_msg.sender_type = 'client' AND last_msg.sender_id = lm_client.id
          LEFT JOIN auth.users lm_user ON last_msg.sender_type = 'staff' AND last_msg.sender_id = lm_user.id
          WHERE last_msg.room_id = cr.id
          ORDER BY last_msg.created_at DESC
          LIMIT 1
        ) as last_message
      FROM chat.chat_rooms cr
      JOIN clients.clients c ON cr.client_id = c.id
      LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
      LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
      LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
      ${whereClause}
      GROUP BY cr.id, c.name, c.email, t.ticket_number, t.title, t.status, u.first_name, u.last_name, u.email
      ${orderBy}
      LIMIT $${++paramCount} OFFSET $${++paramCount}
    `;

    const result = await pool.query(roomsQuery, queryParams);

    // Get total count
    const countParams = queryParams.slice(0, -2);
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT cr.id) as count
       FROM chat.chat_rooms cr
       JOIN clients.clients c ON cr.client_id = c.id
       LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
       LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
       ${whereClause}`,
      countParams
    );

    res.json({
      success: true,
      rooms: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
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
    const result = await pool.query(`
      SELECT 
        COUNT(CASE WHEN room_status = 'active' THEN 1 END) as active_chats,
        COUNT(CASE WHEN assigned_staff_id IS NULL AND room_status = 'active' THEN 1 END) as unassigned_chats,
        COUNT(CASE WHEN room_status = 'closed' AND DATE(closed_at) = CURRENT_DATE THEN 1 END) as closed_today,
        COUNT(CASE WHEN DATE(created_at) = CURRENT_DATE THEN 1 END) as created_today,
        (
          SELECT COUNT(*)
          FROM chat.chat_messages cm
          JOIN chat.chat_rooms cr ON cm.room_id = cr.id
          WHERE cm.is_read = false 
          AND cm.sender_type = 'client'
          AND cr.room_status = 'active'
        ) as unread_messages,
        (
          SELECT AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 60)
          FROM chat.chat_rooms
          WHERE room_status = 'closed'
          AND DATE(closed_at) >= CURRENT_DATE - INTERVAL '7 days'
        ) as avg_resolution_time_minutes
      FROM chat.chat_rooms
    `);

    // Get staff workload
    const staffWorkload = await pool.query(`
      SELECT 
        u.id,
        u.first_name || ' ' || u.last_name as staff_name,
        u.email,
        COUNT(cr.id) as active_chats,
        COUNT(CASE WHEN cr.created_at >= CURRENT_DATE THEN 1 END) as today_chats,
        (
          SELECT COUNT(*)
          FROM chat.chat_messages cm
          JOIN chat.chat_rooms cr2 ON cm.room_id = cr2.id
          WHERE cr2.assigned_staff_id = u.id
          AND cm.sender_type = 'client'
          AND cm.is_read = false
        ) as unread_messages
      FROM auth.users u
      LEFT JOIN chat.chat_rooms cr ON u.id = cr.assigned_staff_id AND cr.room_status = 'active'
      WHERE u.is_active = true
      AND EXISTS (
        SELECT 1 FROM auth.user_roles ur
        JOIN auth.role_permissions rp ON ur.role_id = rp.role_id
        JOIN auth.permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = u.id AND p.code = 'chat.read'
      )
      GROUP BY u.id, u.first_name, u.last_name, u.email
      ORDER BY active_chats DESC
    `);

    res.json({
      success: true,
      metrics: result.rows[0],
      staff_workload: staffWorkload.rows
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

    const { room_ids, assigned_to, notify_staff } = req.body;

    if (!room_ids || !Array.isArray(room_ids) || room_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'room_ids array is required' 
      });
    }

    // Validate staff member
    if (assigned_to) {
      const staffCheck = await client.query(
        'SELECT id FROM auth.users WHERE id = $1 AND is_active = true',
        [assigned_to]
      );
      
      if (staffCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Staff member not found' });
      }
    }

    // Update rooms
    const placeholders = room_ids.map((_, index) => `$${index + 2}`).join(',');
    const result = await client.query(
      `UPDATE chat.chat_rooms 
       SET assigned_staff_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${placeholders})
       AND room_status = 'active'
       RETURNING *`,
      [assigned_to, ...room_ids]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      updated_count: result.rows.length,
      rooms: result.rows
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error bulk assigning chats:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

// Bulk close chats
// Bulk close chats - ВИПРАВЛЕНА ВЕРСІЯ
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

    // Перевіряємо чи існують кімнати та чи вони активні
    const checkRooms = await client.query(
      `SELECT id FROM chat.chat_rooms 
       WHERE id = ANY($1::uuid[]) AND room_status = 'active'`,
      [room_ids]
    );

    if (checkRooms.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'No active rooms found with provided IDs' 
      });
    }

    // ВИПРАВЛЕНО: Правильний SQL запит з типізацією
    const result = await client.query(
      `UPDATE chat.chat_rooms 
       SET room_status = 'closed', 
           closed_at = CURRENT_TIMESTAMP, 
           closed_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($2::uuid[])
       AND room_status = 'active'
       RETURNING *`,
      [req.user.userId, room_ids]
    );

    // Додаємо системні повідомлення з причиною закриття
    for (const room of result.rows) {
      await client.query(
        `INSERT INTO chat.chat_messages (room_id, message_text, sender_id, sender_type)
         VALUES ($1, $2, $3, 'staff')`,
        [
          room.id, 
          `Chat closed by staff. Reason: ${close_reason || 'Bulk operation'}`,
          req.user.userId
        ]
      );
    }

    await client.query('COMMIT');

    // Real-time сповіщення про закриття чатів
    if (global.socketIO) {
      result.rows.forEach(room => {
        global.socketIO.emitToChatRoom(room.id, 'chat_closed', {
          room_id: room.id,
          message: 'Chat has been closed by staff',
          reason: close_reason
        });
      });
    }

    res.json({
      success: true,
      closed_count: result.rows.length,
      rooms: result.rows,
      message: `Successfully closed ${result.rows.length} chat(s)`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error bulk closing chats:', error);
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

    if (!query || query.trim().length < 2) {
      return res.status(400).json({ 
        success: false, 
        message: 'Search query must be at least 2 characters' 
      });
    }

    const searchTerm = `%${query.trim()}%`;
    let results = {
      rooms: [],
      messages: []
    };

    // Search in room/client data
    if (search_type === 'all' || search_type === 'rooms') {
      const roomsResult = await pool.query(`
        SELECT 
          cr.id,
          cr.room_type,
          cr.room_status,
          cr.created_at,
          c.name as client_name,
          c.email as client_email,
          t.ticket_number,
          t.title as ticket_title,
          u.first_name || ' ' || u.last_name as assigned_staff_name
        FROM chat.chat_rooms cr
        JOIN clients.clients c ON cr.client_id = c.id
        LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
        LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
        WHERE (
          c.name ILIKE $1 OR 
          c.email ILIKE $1 OR 
          t.title ILIKE $1 OR 
          t.ticket_number ILIKE $1
        )
        ORDER BY cr.created_at DESC
        LIMIT $2
      `, [searchTerm, limit]);

      results.rooms = roomsResult.rows;
    }

    // Search in messages
    if (search_type === 'all' || search_type === 'messages') {
      const messagesResult = await pool.query(`
        SELECT 
          cm.id,
          cm.room_id,
          cm.message_text,
          cm.sender_type,
          cm.created_at,
          c.name as client_name,
          CASE 
            WHEN cm.sender_type = 'client' THEN c.name
            ELSE u.first_name || ' ' || u.last_name
          END as sender_name,
          cr.room_type
        FROM chat.chat_messages cm
        JOIN chat.chat_rooms cr ON cm.room_id = cr.id
        JOIN clients.clients c ON cr.client_id = c.id
        LEFT JOIN auth.users u ON (cm.sender_type = 'staff' AND cm.sender_id = u.id)
        WHERE cm.message_text ILIKE $1
        ORDER BY cm.created_at DESC
        LIMIT $2
      `, [searchTerm, limit]);

      results.messages = messagesResult.rows;
    }

    res.json({
      success: true,
      query: query.trim(),
      results
    });
  } catch (error) {
    console.error('Error searching chats:', error);
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

    const result = await pool.query(`
      SELECT 
        cr.*,
        c.name as client_name,
        c.email as client_email,
        t.ticket_number,
        t.title as ticket_title,
        t.status as ticket_status,
        u.first_name || ' ' || u.last_name as assigned_staff_name,
        u.email as assigned_staff_email,
        COUNT(cm.id) as total_messages,
        COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'client') as unread_client_messages,
        (
          SELECT json_build_object(
            'id', last_msg.id,
            'message_text', last_msg.message_text,
            'created_at', last_msg.created_at,
            'sender_type', last_msg.sender_type,
            'sender_name',
            CASE 
              WHEN last_msg.sender_type = 'client' THEN lm_client.name
              ELSE lm_user.first_name || ' ' || lm_user.last_name
            END
          )
          FROM chat.chat_messages last_msg
          LEFT JOIN clients.clients lm_client ON last_msg.sender_type = 'client' AND last_msg.sender_id = lm_client.id
          LEFT JOIN auth.users lm_user ON last_msg.sender_type = 'staff' AND last_msg.sender_id = lm_user.id
          WHERE last_msg.room_id = cr.id
          ORDER BY last_msg.created_at DESC
          LIMIT 1
        ) as last_message
      FROM chat.chat_rooms cr
      JOIN clients.clients c ON cr.client_id = c.id
      LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
      LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
      LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
      WHERE cr.id = $1
      GROUP BY cr.id, c.name, c.email, t.ticket_number, t.title, t.status, u.first_name, u.last_name, u.email
    `, [roomId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    res.json({
      success: true,
      room: result.rows[0]
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
    const result = await pool.query(`
      SELECT 
        u.id,
        u.first_name || ' ' || u.last_name as name,
        u.email,
        COUNT(cr.id) as active_chats,
        u.is_active
      FROM auth.users u
      LEFT JOIN chat.chat_rooms cr ON u.id = cr.assigned_staff_id AND cr.room_status = 'active'
      WHERE u.is_active = true
      AND EXISTS (
        SELECT 1 FROM auth.user_roles ur
        JOIN auth.role_permissions rp ON ur.role_id = rp.role_id
        JOIN auth.permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = u.id AND p.code = 'chat.read'
      )
      GROUP BY u.id, u.first_name, u.last_name, u.email, u.is_active
      ORDER BY active_chats ASC, u.first_name ASC
    `);

    res.json({
      success: true,
      staff: result.rows
    });
  } catch (error) {
    console.error('Error fetching available staff:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;