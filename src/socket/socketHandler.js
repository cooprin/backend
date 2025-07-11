const jwt = require('jsonwebtoken');
const { pool } = require('../database');

// Зберігаємо активні з'єднання
const activeConnections = new Map(); // userId -> socketId
const staffRooms = new Map(); // socketId -> Set of room IDs
const ticketRooms = new Map(); // socketId -> Set of ticket IDs

// Middleware для аутентифікації Socket.io
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return next(new Error('No token provided'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Спочатку перевіряємо чи це співробітник
    let result = await pool.query(
      'SELECT id, email, first_name, last_name, \'staff\' as user_type FROM auth.users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );

    if (result.rows.length > 0) {
      socket.user = {
        id: decoded.userId,
        userType: 'staff',
        ...result.rows[0]
      };
      return next();
    }

    // Якщо не співробітник, перевіряємо чи це клієнт
    result = await pool.query(
      'SELECT id, name, email, \'client\' as user_type FROM clients.clients WHERE id = $1 AND is_active = true',
      [decoded.clientId]
    );

    if (result.rows.length > 0) {
      socket.user = {
        id: decoded.clientId,
        userType: 'client',
        ...result.rows[0]
      };
      return next();
    }

    next(new Error('User not found'));
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

    // Повідомляємо про зміну статусу підключення
    io.emit('connection:status_changed', {
      connected: true,
      userType: socket.user.userType,
      totalOnline: activeConnections.size
    });

    // Обробники подій
    setupChatHandlers(io, socket);
    setupTicketHandlers(io, socket);
    setupNotificationHandlers(io, socket);

    // Відключення
    socket.on('disconnect', () => {
      console.log(`User ${socket.user.email} disconnected`);
      activeConnections.delete(socket.user.id);
      staffRooms.delete(socket.id);
      ticketRooms.delete(socket.id);

      // Повідомляємо про зміну статусу підключення
      io.emit('connection:status_changed', {
        connected: false,
        userType: socket.user.userType,
        totalOnline: activeConnections.size
      });
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
    },
    emitToTicketRoom: (ticketId, event, data) => {
      io.to(`ticket_${ticketId}`).emit(event, data);
    },
    emitTicketUpdate: (ticketId, updates) => {
      io.to(`ticket_${ticketId}`).emit('ticket_updated', {
        ticket_id: ticketId,
        updates: updates
      });
    },
    emitTicketCommentAdded: (ticketId, comment) => {
      io.to(`ticket_${ticketId}`).emit('ticket_comment_added', {
        ticket_id: ticketId,
        comment: comment
      });
    },
    emitObjectsUpdate: (objectsData) => {
      // Відправити оновлення об'єктів всім підключеним користувачам
      io.emit('objects_realtime_updated', {
        objectsData: objectsData,
        timestamp: new Date().toISOString()
      });
    },
    emitObjectStatusChange: (objectId, newStatus, clientId = null) => {
      // Відправити зміну статусу об'єкта
      const data = {
        objectId: objectId,
        newStatus: newStatus,
        timestamp: new Date().toISOString()
      };
      
      if (clientId) {
        // Відправити конкретному клієнту
        io.to(`user_${clientId}`).emit('object_status_changed', data);
      } else {
        // Відправити всім
        io.emit('object_status_changed', data);
      }
    },
    getConnectedClients: () => {
      const clients = [];
      activeConnections.forEach((socketId, userId) => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.user) {
          clients.push({
            id: socket.user.id,
            userType: socket.user.userType,
            email: socket.user.email
          });
        }
      });
      return clients;
    },
    getOnlineClientsCount: () => {
      let clientsCount = 0;
      activeConnections.forEach((socketId, userId) => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.user && socket.user.userType === 'client') {
          clientsCount++;
        }
      });
      return clientsCount;
    },
    getOnlineStaffCount: () => {
      let staffCount = 0;
      activeConnections.forEach((socketId, userId) => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.user && socket.user.userType === 'staff') {
          staffCount++;
        }
      });
      return staffCount;
    }
  };

  console.log('Socket.io server initialized');
};

// Обробники для чату
function setupChatHandlers(io, socket) {
  // Приєднання до кімнати чату
  socket.on('join_chat_room', async (roomId) => {
    try {
      // Перевіряємо доступ до кімнати залежно від типу користувача
      let roomCheck;
      if (socket.user.userType === 'client') {
        roomCheck = await pool.query(
          'SELECT id FROM chat.chat_rooms WHERE id = $1 AND client_id = $2',
          [roomId, socket.user.id]
        );
      } else {
        roomCheck = await pool.query(
          'SELECT id FROM chat.chat_rooms WHERE id = $1',
          [roomId]
        );
      }

      if (roomCheck.rows.length > 0) {
        socket.join(`chat_${roomId}`);
        
        // Зберігаємо кімнати
        if (!staffRooms.has(socket.id)) {
          staffRooms.set(socket.id, new Set());
        }
        staffRooms.get(socket.id).add(roomId);

        const userName = socket.user.userType === 'client' ? 
          socket.user.name : 
          `${socket.user.first_name} ${socket.user.last_name}`;

        console.log(`User ${userName} (${socket.user.userType}) joined chat room ${roomId}`);
        
        // Сповіщаємо про приєднання
        socket.to(`chat_${roomId}`).emit('user_joined_room', {
          userId: socket.user.id,
          userType: socket.user.userType,
          userName: userName
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

    const userName = socket.user.userType === 'client' ? 
      socket.user.name : 
      `${socket.user.first_name} ${socket.user.last_name}`;

    socket.to(`chat_${roomId}`).emit('user_left_room', {
      userId: socket.user.id,
      userType: socket.user.userType,
      userName: userName
    });
  });

  // Typing індикатор
  socket.on('typing_start', (roomId) => {
    const userName = socket.user.userType === 'client' ? 
      socket.user.name : 
      `${socket.user.first_name} ${socket.user.last_name}`;

    socket.to(`chat_${roomId}`).emit('user_typing', {
      userId: socket.user.id,
      userType: socket.user.userType,
      userName: userName
    });
  });

  socket.on('typing_stop', (roomId) => {
    socket.to(`chat_${roomId}`).emit('user_stopped_typing', {
      userId: socket.user.id,
      userType: socket.user.userType
    });
  });
}

// Обробники для заявок
function setupTicketHandlers(io, socket) {
  // Приєднання до кімнати заявки
  socket.on('join_ticket_room', async (ticketId) => {
    try {
      // Перевіряємо доступ до заявки залежно від типу користувача
      let ticketCheck;
      if (socket.user.userType === 'client') {
        ticketCheck = await pool.query(
          'SELECT id FROM tickets.tickets WHERE id = $1 AND client_id = $2',
          [ticketId, socket.user.id]
        );
      } else {
        ticketCheck = await pool.query(
          'SELECT id FROM tickets.tickets WHERE id = $1',
          [ticketId]
        );
      }

      if (ticketCheck.rows.length > 0) {
        socket.join(`ticket_${ticketId}`);
        
        // Зберігаємо заявки
        if (!ticketRooms.has(socket.id)) {
          ticketRooms.set(socket.id, new Set());
        }
        ticketRooms.get(socket.id).add(ticketId);

        const userName = socket.user.userType === 'client' ? 
          socket.user.name : 
          `${socket.user.first_name} ${socket.user.last_name}`;

        console.log(`User ${userName} (${socket.user.userType}) joined ticket room ${ticketId}`);
      }
    } catch (error) {
      console.error('Error joining ticket room:', error);
      socket.emit('error', { message: 'Failed to join ticket room' });
    }
  });

  // Покидання кімнати заявки
  socket.on('leave_ticket_room', (ticketId) => {
    socket.leave(`ticket_${ticketId}`);
    
    if (ticketRooms.has(socket.id)) {
      ticketRooms.get(socket.id).delete(ticketId);
    }

    const userName = socket.user.userType === 'client' ? 
      socket.user.name : 
      `${socket.user.first_name} ${socket.user.last_name}`;

    console.log(`User ${userName} left ticket room ${ticketId}`);
  });
}

// Обробники для сповіщень
function setupNotificationHandlers(io, socket) {
  // Отримання непрочитаних сповіщень при підключенні
  socket.on('get_unread_notifications', async () => {
    try {
      const userType = socket.user.userType === 'client' ? 'client' : 'staff';
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM notifications.notifications 
         WHERE recipient_id = $1 AND recipient_type = $2 AND is_read = false`,
        [socket.user.id, userType]
      );

      socket.emit('unread_notifications_count', {
        count: parseInt(result.rows[0].count)
      });
      
      console.log(`Sent unread count ${result.rows[0].count} to user ${socket.user.id}`);
    } catch (error) {
      console.error('Error getting unread notifications:', error);
    }
  });

  // Позначити сповіщення як прочитане
  socket.on('mark_notification_read', async (notificationId) => {
    try {
      const userType = socket.user.userType === 'client' ? 'client' : 'staff';
      await pool.query(
        `UPDATE notifications.notifications 
         SET is_read = true, read_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND recipient_id = $2 AND recipient_type = $3`,
        [notificationId, socket.user.id, userType]
      );

      // Відправити оновлений лічильник
      socket.emit('notification_marked_read', { notificationId });
      console.log(`Marked notification ${notificationId} as read for user ${socket.user.id}`);
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  });

  // Обробник запиту на оновлення об'єктів
  socket.on('request_objects_update', async () => {
    try {
      // Тут можна додати логіку отримання актуальних даних об'єктів
      // Поки що просто логуємо
      console.log(`User ${socket.user.id} requested objects update`);
    } catch (error) {
      console.error('Error handling objects update request:', error);
    }
  });

  // Обробник для статистики підключень
  socket.on('get_connection_stats', async () => {
    try {
      const stats = {
        onlineClients: global.socketIO.getOnlineClientsCount(),
        onlineStaff: global.socketIO.getOnlineStaffCount(),
        totalOnline: global.socketIO.getOnlineClientsCount() + global.socketIO.getOnlineStaffCount()
      };
      
      socket.emit('connection_stats', stats);
      console.log(`Sent connection stats to user ${socket.user.id}:`, stats);
    } catch (error) {
      console.error('Error getting connection stats:', error);
    }
  });
}