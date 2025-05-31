const axios = require('axios');
const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES } = require('../constants/constants');

class WialonIntegrationService {
    // Отримання налаштувань інтеграції
    static async getIntegrationSettings() {
        try {
            const query = `
                SELECT 
                    id, api_url, token_name, encryption_method,
                    CASE WHEN token_value IS NOT NULL THEN true ELSE false END as has_token,
                    is_active, last_sync_time, sync_interval, additional_settings,
                    created_at, updated_at
                FROM company.wialon_integration
                ORDER BY created_at DESC
                LIMIT 1
            `;
            
            const result = await pool.query(query);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error fetching wialon integration settings:', error);
            throw error;
        }
    }

    // Збереження налаштувань інтеграції
    static async saveIntegrationSettings(client, data, userId, req) {
        try {
            // Перевірка обов'язкових полів
            const requiredFields = ['api_url', 'token_name'];
            
            for (const field of requiredFields) {
                if (!data[field]) {
                    throw new Error(`Поле ${field} є обов'язковим`);
                }
            }
    
            let integrationId;
            let actionType = 'WIALON_INTEGRATION_CREATE';
            
            // Перевірка, чи вже є запис для інтеграції
            const existingRecord = await client.query(
                'SELECT id FROM company.wialon_integration LIMIT 1'
            );
    
            if (existingRecord.rows.length > 0) {
                actionType = 'WIALON_INTEGRATION_UPDATE';
                integrationId = existingRecord.rows[0].id;
            }
    
            // Якщо є токен, використовуємо PostgreSQL функцію для збереження
            if (data.token_value) {
                // Отримуємо ключ шифрування з змінної оточення
                const encryptionKey = process.env.WIALON_ENCRYPTION_KEY;
                
                if (!encryptionKey) {
                    throw new Error('WIALON_ENCRYPTION_KEY не встановлено в змінних оточення');
                }
                
                const result = await client.query(
                    'SELECT company.set_wialon_token($1, $2, $3, $4, $5, $6, $7) as integration_id',
                    [
                        data.api_url,
                        data.token_name,
                        data.token_value,
                        data.sync_interval || 60,
                        data.additional_settings ? JSON.stringify(data.additional_settings) : '{}',
                        userId,
                        encryptionKey  // Передаємо ключ як параметр
                    ]
                );
                integrationId = result.rows[0].integration_id;
            } else if (existingRecord.rows.length > 0) {
                // Оновлення без токена (залишається без змін)
                const fields = [];
                const values = [];
                let paramIndex = 1;
                
                const updateableFields = ['api_url', 'token_name', 'is_active', 'sync_interval', 'additional_settings'];
                
                updateableFields.forEach(field => {
                    if (data[field] !== undefined) {
                        fields.push(`${field} = $${paramIndex++}`);
                        
                        if (field === 'additional_settings' && typeof data[field] === 'object') {
                            values.push(JSON.stringify(data[field]));
                        } else {
                            values.push(data[field]);
                        }
                    }
                });
                
                if (fields.length > 0) {
                    fields.push(`updated_at = $${paramIndex++}`);
                    values.push(new Date());
                    values.push(integrationId);
                    
                    const query = `
                        UPDATE company.wialon_integration 
                        SET ${fields.join(', ')} 
                        WHERE id = $${paramIndex}
                        RETURNING id
                    `;
                    
                    await client.query(query, values);
                }
            } else {
                throw new Error('Токен є обов\'язковим для створення нової інтеграції');
            }
            
            // Для аудиту зберігаємо все, крім токену
            const auditData = { ...data };
            delete auditData.token_value;
            
            // Аудит
            await AuditService.log({
                userId,
                actionType,
                entityType: 'WIALON_INTEGRATION',
                entityId: integrationId,
                oldValues: null,
                newValues: auditData,
                ipAddress: req.ip,
                tableSchema: 'company',
                tableName: 'wialon_integration',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return { id: integrationId };
        } catch (error) {
            console.error('Error saving wialon integration settings:', error);
            throw error;
        }
    }
// Тестування підключення до Wialon
static async testConnection() {
    try {
        const tokenData = await this.getWialonToken();
        
        if (!tokenData) {
            throw new Error('Налаштування інтеграції не знайдено');
        }
        
        console.log('Testing Wialon connection...');
        console.log('API URL:', tokenData.api_url);
        console.log('Token name:', tokenData.token_name);
        console.log('Token length:', tokenData.decrypted_token?.length);
        
        // Формуємо URL для тестового запиту
        const testUrl = `${tokenData.api_url}/wialon/ajax.html?svc=token/login&params={"token":"${tokenData.decrypted_token}"}`;
        
        console.log('Making request to Wialon...');
        
        // Виконуємо запит до Wialon
        const response = await axios.get(testUrl, {
            timeout: 10000, // 10 секунд таймаут
            headers: {
                'User-Agent': 'ERP-System/1.0'
            }
        });
        
        console.log('Wialon response status:', response.status);
        console.log('Wialon response data:', JSON.stringify(response.data, null, 2));
        
        // Перевіряємо відповідь
        if (response.data && response.data.error === 0) {
            // Оновлюємо час останньої синхронізації
            await pool.query('SELECT company.update_wialon_sync_time()');
            
            return {
                success: true,
                message: 'Підключення успішне',
                userData: response.data.user || {},
                time: new Date()
            };
        } else {
            console.log('Wialon error code:', response.data?.error);
            console.log('Wialon error text:', response.data?.error_text);
            
            const errorText = response.data?.error_text || 'Невідома помилка';
            throw new Error('Помилка авторизації: ' + errorText);
        }
    } catch (error) {
        console.error('Error testing wialon connection:', error.message);
        console.error('Full error:', error);
        
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        
        return {
            success: false,
            message: error.message || 'Помилка підключення до Wialon',
            error: error
        };
    }
}

    // Отримання розшифрованого токена через PostgreSQL функцію
    static async getWialonToken() {
        try {
            const result = await pool.query('SELECT * FROM company.get_wialon_token()');
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error getting wialon token:', error);
            throw error;
        }
    }

    // Синхронізація об'єктів з Wialon (оновлена версія)
    static async syncObjects(client, userId, req) {
        try {
            const tokenData = await this.getWialonToken();
            
            if (!tokenData) {
                throw new Error('Налаштування інтеграції не знайдено');
            }
            
            // Спочатку авторизуємся
            const loginUrl = `${tokenData.api_url}/wialon/ajax.html?svc=token/login&params={"token":"${tokenData.decrypted_token}"}`;
            
            const loginResponse = await axios.get(loginUrl);
            
            if (!loginResponse.data || loginResponse.data.error !== 0) {
                throw new Error('Помилка авторизації: ' + 
                    (loginResponse.data && loginResponse.data.error_text ? loginResponse.data.error_text : 'Невідома помилка'));
            }
            
            // Отримуємо ід сесії
            const eid = loginResponse.data.eid;
            
            if (!eid) {
                throw new Error('Не отримано ід сесії');
            }
            
            // Отримуємо список об'єктів
            const searchUrl = `${tokenData.api_url}/wialon/ajax.html?svc=core/search_items&params={"spec":{"itemsType":"avl_unit","propName":"sys_name","propValueMask":"*","sortType":"sys_name"},"force":1,"flags":1025,"from":0,"to":0}&sid=${eid}`;
            
            const searchResponse = await axios.get(searchUrl);
            
            if (!searchResponse.data || searchResponse.data.error !== 0) {
                throw new Error('Помилка отримання об\'єктів: ' + 
                    (searchResponse.data && searchResponse.data.error_text ? searchResponse.data.error_text : 'Невідома помилка'));
            }
            
            const wialonObjects = searchResponse.data.items || [];
            
            // Отримуємо список клієнтів з Wialon ID
            const clientsQuery = await client.query(
                'SELECT id, wialon_id FROM clients.clients WHERE wialon_id IS NOT NULL'
            );
            
            const clientsMap = {};
            clientsQuery.rows.forEach(row => {
                clientsMap[row.wialon_id] = row.id;
            });
            
            // Лічильники для статистики
            let created = 0;
            let updated = 0;
            let skipped = 0;
            
            // Для кожного об'єкта в Wialon
            for (const wialonObj of wialonObjects) {
                // Перевіряємо чи є власник об'єкта в нашій системі
                const creatorId = wialonObj.creatorId;
                
                if (!creatorId || !clientsMap[creatorId]) {
                    // Пропускаємо об'єкти без відомого власника
                    skipped++;
                    continue;
                }
                
                const clientId = clientsMap[creatorId];
                
                // Перевіряємо чи є цей об'єкт вже в нашій системі
                const existingObj = await client.query(
                    'SELECT id FROM wialon.objects WHERE wialon_id = $1',
                    [wialonObj.id]
                );
                
                if (existingObj.rows.length > 0) {
                    // Оновлюємо існуючий об'єкт
                    await client.query(
                        `UPDATE wialon.objects 
                         SET name = $1, description = $2, client_id = $3, 
                             status = $4, updated_at = $5
                         WHERE wialon_id = $6`,
                        [
                            wialonObj.nm || 'Невідомий об\'єкт',
                            `Wialon ID: ${wialonObj.id}`,
                            clientId,
                            'active',
                            new Date(),
                            wialonObj.id
                        ]
                    );
                    updated++;
                } else {
                    // Створюємо новий об'єкт
                    await client.query(
                        `INSERT INTO wialon.objects 
                         (wialon_id, name, description, client_id, status)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [
                            wialonObj.id,
                            wialonObj.nm || 'Невідомий об\'єкт',
                            `Wialon ID: ${wialonObj.id}`,
                            clientId,
                            'active'
                        ]
                    );
                    created++;
                }
                
                // Додаємо додаткові атрибути об'єкта
                if (wialonObj.netconn && typeof wialonObj.netconn === 'object') {
                    await this.updateObjectAttribute(client, wialonObj.id, 'netconn_status', wialonObj.netconn.status || 'unknown');
                    
                    if (wialonObj.netconn.last_connect) {
                        await this.updateObjectAttribute(
                            client, 
                            wialonObj.id, 
                            'last_connect', 
                            new Date(wialonObj.netconn.last_connect * 1000).toISOString()
                        );
                    }
                }
            }
            
            // Оновлюємо час останньої синхронізації
            await pool.query('SELECT company.update_wialon_sync_time()');
            
            // Логування
            await AuditService.log({
                userId,
                actionType: 'WIALON_SYNC',
                entityType: 'WIALON_INTEGRATION',
                entityId: tokenData.integration_id,
                newValues: {
                    created,
                    updated,
                    skipped,
                    total_objects: wialonObjects.length
                },
                ipAddress: req.ip,
                tableSchema: 'wialon',
                tableName: 'objects',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return {
                success: true,
                created,
                updated,
                skipped,
                total: wialonObjects.length
            };
        } catch (error) {
            console.error('Error syncing wialon objects:', error);
            throw error;
        }
    }

    // Допоміжний метод для оновлення атрибуту об'єкта (без змін)
    static async updateObjectAttribute(client, wialonId, attrName, attrValue) {
        try {
            // Спочатку знаходимо об'єкт за wialonId
            const objResult = await client.query(
                'SELECT id FROM wialon.objects WHERE wialon_id = $1',
                [wialonId]
            );
            
            if (objResult.rows.length === 0) {
                return false;
            }
            
            const objectId = objResult.rows[0].id;
            
            // Перевіряємо чи існує такий атрибут
            const attrResult = await client.query(
                'SELECT id FROM wialon.object_attributes WHERE object_id = $1 AND attribute_name = $2',
                [objectId, attrName]
            );
            
            if (attrResult.rows.length > 0) {
                // Оновлюємо існуючий атрибут
                await client.query(
                    `UPDATE wialon.object_attributes 
                     SET attribute_value = $1, updated_at = $2
                     WHERE object_id = $3 AND attribute_name = $4`,
                    [
                        attrValue,
                        new Date(),
                        objectId,
                        attrName
                    ]
                );
            } else {
                // Створюємо новий атрибут
                await client.query(
                    `INSERT INTO wialon.object_attributes 
                     (object_id, attribute_name, attribute_value)
                     VALUES ($1, $2, $3)`,
                    [
                        objectId,
                        attrName,
                        attrValue
                    ]
                );
            }
            
            return true;
        } catch (error) {
            console.error('Error updating object attribute:', error);
            return false;
        }
    }

    // Видаляємо старі методи шифрування (encryptToken та decryptToken)
    // Тепер використовуємо PostgreSQL функції
}

module.exports = WialonIntegrationService;