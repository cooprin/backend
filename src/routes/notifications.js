const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient } = require('../middleware/clientAccess');

// Отримання сповіщень для поточного користувача
router.get('/', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    let recipientId, recipientType;
    if (req.user.userType === 'client') {
      recipientId = req.user.clientId;
      recipientType = 'client';
    } else {
      recipientId = req.user.userId;
      recipientType = 'staff';
    }

    const result = await pool.query(
      `SELECT * FROM notifications.view_notifications_with_details
       WHERE recipient_id = $1 AND recipient_type = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [recipientId, recipientType, limit, offset]
    );

    // Підрахунок загальної кількості
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM notifications.notifications
       WHERE recipient_id = $1 AND recipient_type = $2`,
      [recipientId, recipientType]
    );

    res.json({
      success: true,
      notifications: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Отримання кількості непрочитаних сповіщень
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    let recipientId, recipientType;
    if (req.user.userType === 'client') {
      recipientId = req.user.clientId;
      recipientType = 'client';
    } else {
      recipientId = req.user.userId;
      recipientType = 'staff';
    }

    const result = await pool.query(
      `SELECT * FROM notifications.view_unread_notifications
       WHERE recipient_id = $1 AND recipient_type = $2`,
      [recipientId, recipientType]
    );

    const counts = result.rows[0] || {
      unread_count: 0,
      new_tickets_count: 0,
      ticket_comments_count: 0,
      chat_messages_count: 0,
      assigned_tickets_count: 0,
      assigned_chats_count: 0
    };

    res.json({
      success: true,
      counts
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Позначити сповіщення як прочитане
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    let recipientId, recipientType;
    if (req.user.userType === 'client') {
      recipientId = req.user.clientId;
      recipientType = 'client';
    } else {
      recipientId = req.user.userId;
      recipientType = 'staff';
    }

    const result = await pool.query(
      `UPDATE notifications.notifications 
       SET is_read = true, read_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND recipient_id = $2 AND recipient_type = $3
       RETURNING *`,
      [id, recipientId, recipientType]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    // Real-time оновлення лічильника сповіщень
if (global.socketIO) {
  global.socketIO.emitToUser(recipientId, 'notification_read', {
    notification_id: id,
    unread_count_change: -1
  });
}

    res.json({
      success: true,
      notification: result.rows[0]
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Позначити всі сповіщення як прочитані
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    let recipientId, recipientType;
    if (req.user.userType === 'client') {
      recipientId = req.user.clientId;
      recipientType = 'client';
    } else {
      recipientId = req.user.userId;
      recipientType = 'staff';
    }

    const result = await pool.query(
      `UPDATE notifications.notifications 
       SET is_read = true, read_at = CURRENT_TIMESTAMP
       WHERE recipient_id = $1 AND recipient_type = $2 AND is_read = false
       RETURNING id`,
      [recipientId, recipientType]
    );

    // Real-time оновлення лічильника сповіщень
if (global.socketIO && result.rows.length > 0) {
  global.socketIO.emitToUser(recipientId, 'notifications_all_read', {
    marked_count: result.rows.length
  });
}

    res.json({
      success: true,
      marked_count: result.rows.length
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;