const { pool } = require('../database');
const { PortalApi } = require('../api/portal'); // Припускаю що є такий API

class ObjectsRealtimeService {
  constructor() {
    this.updateInterval = null;
    this.isRunning = false;
  }

  // Запуск періодичного оновлення
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('🚗 Starting objects real-time service...');
    
    // Оновлюємо кожні 60 секунд
    this.updateInterval = setInterval(() => {
      this.sendObjectsUpdate();
    }, 60000);
    
    // Перше оновлення відразу
    this.sendObjectsUpdate();
  }

  // Зупинка сервісу
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.isRunning = false;
    console.log('🛑 Objects real-time service stopped');
  }

  // Відправка оновлень об'єктів
  async sendObjectsUpdate() {
    try {
      if (!global.socketIO) {
        return;
      }

      // Отримуємо real-time дані об'єктів (використовуємо існуючий API)
      const objectsData = await this.getObjectsRealTimeData();
      
      if (objectsData && objectsData.length > 0) {
        // Відправляємо через Socket.IO
        global.socketIO.emitObjectsUpdate(objectsData);
        console.log(`📡 Sent real-time data for ${objectsData.length} objects`);
      }
    } catch (error) {
      console.error('Error sending objects update:', error);
    }
  }

async getObjectsRealTimeData() {
  try {
    // Перевіряємо хто зараз онлайн і дивиться об'єкти
    if (!global.socketIO || !global.socketIO.getConnectedClients) {
      return [];
    }

    const connectedClients = global.socketIO.getConnectedClients();
    
    // Фільтруємо тільки клієнтів (не staff)
    const onlineClientIds = connectedClients
      .filter(client => client.userType === 'client')
      .map(client => client.id);

    if (onlineClientIds.length === 0) {
      console.log('No online clients - skipping real-time update');
      return [];
    }

    console.log(`Updating real-time data for ${onlineClientIds.length} online clients`);

    const WialonIntegrationService = require('./wialon-integration.service');
    const allObjectsData = [];
    
    // Отримуємо дані тільки для онлайн клієнтів
    for (const clientId of onlineClientIds) {
      try {
        const clientObjectsData = await WialonIntegrationService.getObjectsRealTimeData(clientId);
        allObjectsData.push(...clientObjectsData);
      } catch (error) {
        console.error(`Error getting real-time data for client ${clientId}:`, error);
      }
    }
    
    return allObjectsData;
  } catch (error) {
    console.error('Error getting objects real-time data:', error);
    return [];
  }
}
}

module.exports = new ObjectsRealtimeService();