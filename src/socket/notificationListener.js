const { pool } = require('../database');

// Слухач для PostgreSQL NOTIFY подій
function setupNotificationListener() {
  // Створюємо окреме з'єднання для LISTEN
  const client = pool.connect();
  
  client.then(async (pgClient) => {
    console.log('PostgreSQL notification listener connected');

    // Підписуємося на канал new_notification
    await pgClient.query('LISTEN new_notification');

    // Обробляємо NOTIFY події
    pgClient.on('notification', (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        handleNewNotification(payload);
      } catch (error) {
        console.error('Error parsing notification payload:', error);
      }
    });

    // Обробка помилок з'єднання
    pgClient.on('error', (err) => {
      console.error('PostgreSQL notification listener error:', err);
      // Спробувати перез'єднатися через 5 секунд
      setTimeout(setupNotificationListener, 5000);
    });

  }).catch(error => {
    console.error('Failed to setup notification listener:', error);
    // Спробувати перез'єднатися через 5 секунд
    setTimeout(setupNotificationListener, 5000);
  });
}

// Обробка нового сповіщення
function handleNewNotification(payload) {
  console.log('New notification received:', payload);

  if (!global.socketIO) {
    console.warn('Socket.IO not available for notification');
    return;
  }

  const {
    notification_id,
    recipient_id,
    recipient_type,
    notification_type,
    title,
    message,
    entity_type,
    entity_id,
    data,
    unread_count
  } = payload;

  // Відправляємо сповіщення конкретному користувачу
  if (recipient_type === 'staff') {
    global.socketIO.emitToUser(recipient_id, 'new_notification', {
      id: notification_id,
      notification_type,
      title,
      message,
      entity_type,
      entity_id,
      data: typeof data === 'string' ? JSON.parse(data) : data,
      unread_count,
      created_at: new Date().toISOString()
    });

    // Оновлюємо лічильник непрочитаних
    global.socketIO.emitToUser(recipient_id, 'unread_count_updated', {
      unread_count
    });
  }

  // Якщо це групове сповіщення для всіх співробітників
  if (notification_type === 'system_announcement') {
    global.socketIO.broadcastToStaff('system_notification', {
      id: notification_id,
      title,
      message,
      created_at: new Date().toISOString()
    });
  }
}

module.exports = {
  setupNotificationListener
};