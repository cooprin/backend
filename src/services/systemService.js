const { pool } = require('../database');

class SystemService {
  // Отримати онлайн статистику
  static async getOnlineStats() {
    try {
      let onlineClients = 0;
      let onlineStaff = 0;

      // Отримуємо дані з socketIO якщо доступно
      if (global.socketIO) {
        onlineClients = global.socketIO.getOnlineClientsCount();
        onlineStaff = global.socketIO.getOnlineStaffCount();
      }

      return {
        onlineClients,
        onlineStaff,
        totalOnline: onlineClients + onlineStaff
      };
    } catch (error) {
      console.error('Error getting online stats:', error);
      throw error;
    }
  }

  // Отримати системний статус
  static async getSystemStatus() {
    try {
      // Перевіряємо з'єднання з базою даних
      const dbStatus = await this.checkDatabaseConnection();
      
      // Перевіряємо статус Socket.IO
      const socketStatus = global.socketIO ? 'connected' : 'disconnected';
      
      // Перевіряємо статус Wialon (можна розширити пізніше)
      const wialonStatus = 'connected'; // Поки що статично

      return {
        database: dbStatus,
        sockets: socketStatus,
        wialon: wialonStatus,
        systemStatus: dbStatus === 'connected' && socketStatus === 'connected' ? 'healthy' : 'issues'
      };
    } catch (error) {
      console.error('Error getting system status:', error);
      throw error;
    }
  }

  // Перевірити з'єднання з базою даних
  static async checkDatabaseConnection() {
    try {
      await pool.query('SELECT 1');
      return 'connected';
    } catch (error) {
      console.error('Database connection error:', error);
      return 'disconnected';
    }
  }
}

module.exports = SystemService;