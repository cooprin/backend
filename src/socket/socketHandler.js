const jwt = require('jsonwebtoken');
const { pool } = require('../database');

// Зберігаємо активні з'єднання
const activeConnections = new Map(); // userId -> socketId
const staffRooms = new Map(); // socketId -> Set of room IDs

// Middleware для аутентифікації Socket.io
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return next(new Error('No token provided'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Отримуємо користувача з бази
    const result = await pool.query(
      'SELECT id, email, first_name, last_name FROM auth.users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return next(new Error('User not found'));
    }

    socket.user = {
      id: decoded.userId,
      userType: 'staff',
      ...result.rows[0]
    };

    next();
  } catch (error) {
    console.error('Socket authentication error:', error);
    next(new Error('Authentication failed'));
  }
};

// Головна функція Socket.io
module.exports = (io) => {
  // Middleware для аутентифікації
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    console.log(`User ${socket.user.email} connected (${socket.id})`);

    // Зберігаємо з'єднання
    activeConnections.set(socket.user.id, socket.id);
    
    // Приєднуємося до особистої кімнати для сповіщень
    socket.join(`user_${socket.user.id}`);

    // Обробники подій
    setupChatHandlers(io, socket);
    setupNotificationHandlers(io, socket);

    // Відключення
    socket.on('disconnect', () => {
      console.log(`User ${socket.user.email} disconnected`);
      activeConnections.delete(socket.user.id);
      staffRooms.delete(socket.id);
    });
  });

  // Експортуємо функції для використання в інших частинах додатка
  global.socketIO = {
    io,
    emitToUser: (userId, event, data) => {
      const socketId = activeConnections.get(userId);
      if (socketId) {
        io.to(`user_${userId}`).emit(event, data);
      }
    },
    emitToChatRoom: (roomId, event, data) => {
      io.to(`chat_${roomId}`).emit(event, data);
    },
    broadcastToStaff: (event, data) => {
      // Відправити всім активним співробітникам
      activeConnections.forEach((socketId, userId) => {
        io.to(`user_${userId}`).emit(event, data);
      });
    }
  };

  console.log('Socket.io server initialized');
};

// Обробники для чату
function setupChatHandlers(io, socket) {
  // Приєднання до кімнати чату
  socket.on('join_chat_room', async (roomId) => {
    try {
      // Перевіряємо доступ до кімнати
      const roomCheck = await pool.query(
        'SELECT id FROM chat.chat_rooms WHERE id = $1',
        [roomId]
      );

      if (roomCheck.rows.length > 0) {
        socket.join(`chat_${roomId}`);
        
        // Зберігаємо для staff
        if (!staffRooms.has(socket.id)) {
          staffRooms.set(socket.id, new Set());
        }
        staffRooms.get(socket.id).add(roomId);

        console.log(`User ${socket.user.email} joined chat room ${roomId}`);
        
        // Сповіщаємо про приєднання
        socket.to(`chat_${roomId}`).emit('user_joined_room', {
          userId: socket.user.id,
          userName: `${socket.user.first_name} ${socket.user.last_name}`
        });
      }
    } catch (error) {
      console.error('Error joining chat room:', error);
      socket.emit('error', { message: 'Failed to join chat room' });
    }
  });

  // Покидання кімнати чату
  socket.on('leave_chat_room', (roomId) => {
    socket.leave(`chat_${roomId}`);
    
    if (staffRooms.has(socket.id)) {
      staffRooms.get(socket.id).delete(roomId);
    }

    socket.to(`chat_${roomId}`).emit('user_left_room', {
      userId: socket.user.id,
      userName: `${socket.user.first_name} ${socket.user.last_name}`
    });
  });

  // Typing індикатор
  socket.on('typing_start', (roomId) => {
    socket.to(`chat_${roomId}`).emit('user_typing', {
      userId: socket.user.id,
      userName: `${socket.user.first_name} ${socket.user.last_name}`
    });
  });

  socket.on('typing_stop', (roomId) => {
    socket.to(`chat_${roomId}`).emit('user_stopped_typing', {
      userId: socket.user.id
    });
  });
}

// Обробники для сповіщень
function setupNotificationHandlers(io, socket) {
  // Отримання непрочитаних сповіщень при підключенні
  socket.on('get_unread_notifications', async () => {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM notifications.notifications 
         WHERE recipient_id = $1 AND recipient_type = 'staff' AND is_read = false`,
        [socket.user.id]
      );

      socket.emit('unread_notifications_count', {
        count: parseInt(result.rows[0].count)
      });
    } catch (error) {
      console.error('Error getting unread notifications:', error);
    }
  });

  // Позначити сповіщення як прочитане
  socket.on('mark_notification_read', async (notificationId) => {
    try {
      await pool.query(
        `UPDATE notifications.notifications 
         SET is_read = true, read_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND recipient_id = $2`,
        [notificationId, socket.user.id]
      );

      // Відправити оновлений лічильник
      socket.emit('notification_marked_read', { notificationId });
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  });
}