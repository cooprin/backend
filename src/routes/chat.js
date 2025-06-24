const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient } = require('../middleware/clientAccess');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Setup file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.env.UPLOAD_DIR, 'chat');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'chat-' + uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 5
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
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
        cr.is_active, cr.last_message_at, cr.created_at,
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

// Create new chat room
router.post('/rooms', authenticate, restrictToOwnData, async (req, res) => {
  try {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { room_type = 'support', ticket_id } = req.body;

    // Validate ticket belongs to client if specified
    if (ticket_id) {
      const ticketCheck = await pool.query(
        'SELECT id FROM tickets.tickets WHERE id = $1 AND client_id = $2',
        [ticket_id, req.user.clientId]
      );
      
      if (ticketCheck.rows.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ticket not found or access denied' 
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO chat.chat_rooms (client_id, ticket_id, room_type)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.user.clientId, ticket_id, room_type]
    );

    res.status(201).json({
      success: true,
      room: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating chat room:', error);
    res.status(500).json({ success: false, message: 'Server error' });
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
        END as sender_name,
        COUNT(cf.id) as files_count
      FROM chat.chat_messages cm
      LEFT JOIN clients.clients c ON (cm.sender_type = 'client' AND cm.sender_id = c.id)
      LEFT JOIN auth.users u ON (cm.sender_type = 'staff' AND cm.sender_id = u.id)
      LEFT JOIN chat.chat_files cf ON cm.id = cf.message_id
      WHERE cm.room_id = $1
      GROUP BY cm.id, c.name, u.first_name, u.last_name
      ORDER BY cm.created_at DESC
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
      messages: result.rows.reverse(), // Reverse to show oldest first
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
router.post('/rooms/:roomId/messages', authenticate, staffOrClient, upload.array('files', 5), async (req, res) => {
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

    // Handle file uploads
    const files = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileResult = await client.query(
          `INSERT INTO chat.chat_files 
           (message_id, file_name, original_name, file_path, file_size, mime_type)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            message.id,
            file.filename,
            file.originalname,
            file.path.replace(process.env.UPLOAD_DIR, ''),
            file.size,
            file.mimetype
          ]
        );
        files.push(fileResult.rows[0]);
      }
    }

    // Update room last message time
    await client.query(
      'UPDATE chat.chat_rooms SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1',
      [roomId]
    );

    await client.query('COMMIT');

    // Get sender name for response
    let senderName;
    if (senderType === 'client') {
      const clientResult = await pool.query('SELECT name FROM clients.clients WHERE id = $1', [senderId]);
      senderName = clientResult.rows[0]?.name;
    } else {
      const userResult = await pool.query('SELECT first_name, last_name FROM auth.users WHERE id = $1', [senderId]);
      const user = userResult.rows[0];
      senderName = user ? `${user.first_name} ${user.last_name}` : null;
    }

    res.status(201).json({
      success: true,
      message: {
        ...message,
        sender_name: senderName,
        files,
        files_count: files.length
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    
    // Clean up uploaded files on error
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }
    
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

// Download chat file
router.get('/files/:fileId/download', authenticate, staffOrClient, async (req, res) => {
  try {
    const { fileId } = req.params;

    // Get file info
    const fileResult = await pool.query(
      `SELECT cf.*, cm.room_id 
       FROM chat.chat_files cf
       JOIN chat.chat_messages cm ON cf.message_id = cm.id
       WHERE cf.id = $1`,
      [fileId]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    const file = fileResult.rows[0];

    // Check access to room
    if (req.user.userType === 'client') {
      const roomCheck = await pool.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1 AND client_id = $2',
        [file.room_id, req.user.clientId]
      );
      
      if (roomCheck.rows.length === 0) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    const filePath = path.join(process.env.UPLOAD_DIR, file.file_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'File not found on server' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${file.original_name}"`);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;