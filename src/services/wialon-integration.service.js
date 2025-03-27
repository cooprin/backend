const axios = require('axios');
const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES } = require('../constants/constants');
const crypto = require('crypto');

class WialonIntegrationService {
    // Отримання налаштувань інтеграції
    static async getIntegrationSettings() {
        try {
            const query = `
                SELECT 
                    id, api_url, token_name, 
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
            
            // Перевірка, чи вже є запис для інтеграції
            const existingRecord = await client.query(
                'SELECT id, token_value FROM company.wialon_integration LIMIT 1'
            );

            let integrationId;
            let oldData = null;
            let actionType = 'WIALON_INTEGRATION_CREATE';
            let encryptedToken = null;

            // Шифруємо токен, якщо він вказаний
            if (data.token_value) {
                encryptedToken = this.encryptToken(data.token_value);
            }

            if (existingRecord.rows.length > 0) {
                // Оновлення існуючого запису
                integrationId = existingRecord.rows[0].id;
                oldData = await client.query(
                    'SELECT * FROM company.wialon_integration WHERE id = $1',
                    [integrationId]
                );
                oldData = oldData.rows[0];
                actionType = 'WIALON_INTEGRATION_UPDATE';

                // Підготовка полів для оновлення
                const fields = [];
                const values = [];
                let paramIndex = 1;
                
                // Доступні поля для оновлення
                const updateableFields = [
                    'api_url', 'token_name', 'is_active', 'sync_interval', 'additional_settings'
                ];
                
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
                
                // Додаємо token_value, якщо він був переданий
                if (encryptedToken) {
                    fields.push(`token_value = $${paramIndex++}`);
                    values.push(encryptedToken);
                }
                
                // Додаємо updated_at
                fields.push(`updated_at = $${paramIndex++}`);
                values.push(new Date());
                
                // Додаємо id для WHERE
                values.push(integrationId);
                
                if (fields.length === 0) {
                    throw new Error('Не вказано полів для оновлення');
                }
                
                const query = `
                    UPDATE company.wialon_integration 
                    SET ${fields.join(', ')} 
                    WHERE id = $${paramIndex}
                    RETURNING id, api_url, token_name, 
                            CASE WHEN token_value IS NOT NULL THEN true ELSE false END as has_token,
                            is_active, last_sync_time, sync_interval, additional_settings,
                            created_at, updated_at
                `;
                
                const result = await client.query(query, values);
                integrationId = result.rows[0].id;
            } else {
                // Створення нового запису
                const query = `
                    INSERT INTO company.wialon_integration (
                        api_url, token_name, token_value, is_active, sync_interval, 
                        additional_settings, created_by
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7
                    )
                    RETURNING id, api_url, token_name, 
                             CASE WHEN token_value IS NOT NULL THEN true ELSE false END as has_token,
                             is_active, last_sync_time, sync_interval, additional_settings,
                             created_at, updated_at
                `;
                
                const result = await client.query(query, [
                    data.api_url,
                    data.token_name,
                    encryptedToken,
                    data.is_active !== undefined ? data.is_active : true,
                    data.sync_interval || 60, // За замовчуванням 60 хвилин
                    data.additional_settings ? JSON.stringify(data.additional_settings) : null,
                    userId
                ]);
                
                integrationId = result.rows[0].id;
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
                oldValues: oldData ? {
                    api_url: oldData.api_url,
                    token_name: oldData.token_name,
                    is_active: oldData.is_active,
                    sync_interval: oldData.sync_interval,
                    additional_settings: oldData.additional_settings
                } : null,
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
    static async testConnection(integrationId) {
        try {
            const settings = await this.getIntegrationSettingsWithToken(integrationId);
            
            if (!settings) {
                throw new Error('Налаштування інтеграції не знайдено');
            }
            
            if (!settings.token_value) {
                throw new Error('Токен не налаштовано');
            }
            
            // Формуємо URL для тестового запиту
            const tokenValue = this.decryptToken(settings.token_value);
            const testUrl = `${settings.api_url}/wialon/ajax.html?svc=token/login&params={"token":"${tokenValue}"}`;
            
            // Виконуємо запит до Wialon
            const response = await axios.get(testUrl);
            
            // Перевіряємо відповідь
            if (response.data && response.data.error === 0) {
                // Оновлюємо час останньої синхронізації
                await pool.query(
                    'UPDATE company.wialon_integration SET last_sync_time = $1 WHERE id = $2',
                    [new Date(), settings.id]
                );
                
                return {
                    success: true,
                    message: 'Підключення успішне',
                    userData: response.data.user || {},
                    time: new Date()
                };
            } else {
                throw new Error('Помилка авторизації: ' + 
                    (response.data && response.data.error_text ? response.data.error_text : 'Невідома помилка'));
            }
        } catch (error) {
            console.error('Error testing wialon connection:', error);
            return {
                success: false,
                message: error.message || 'Помилка підключення до Wialon',
                error: error
            };
        }
    }

    // Отримання налаштувань з токеном
    static async getIntegrationSettingsWithToken(integrationId) {
        try {
            let query = `
                SELECT * FROM company.wialon_integration
            `;
            
            const params = [];
            if (integrationId) {
                query += ' WHERE id = $1';
                params.push(integrationId);
            } else {
                query += ' ORDER BY created_at DESC LIMIT 1';
            }
            
            const result = await pool.query(query, params);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error fetching wialon integration settings with token:', error);
            throw error;
        }
    }

    // Синхронізація об'єктів з Wialon
    static async syncObjects(client, userId, req) {
        try {
            const settings = await this.getIntegrationSettingsWithToken();
            
            if (!settings) {
                throw new Error('Налаштування інтеграції не знайдено');
            }
            
            if (!settings.token_value) {
                throw new Error('Токен не налаштовано');
            }
            
            // Отримуємо токен
            const tokenValue = this.decryptToken(settings.token_value);
            
            // Спочатку авторизуємось
            const loginUrl = `${settings.api_url}/wialon/ajax.html?svc=token/login&params={"token":"${tokenValue}"}`;
            
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
            const searchUrl = `${settings.api_url}/wialon/ajax.html?svc=core/search_items&params={"spec":{"itemsType":"avl_unit","propName":"sys_name","propValueMask":"*","sortType":"sys_name"},"force":1,"flags":1025,"from":0,"to":0}&sid=${eid}`;
            
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
            await client.query(
                'UPDATE company.wialon_integration SET last_sync_time = $1 WHERE id = $2',
                [new Date(), settings.id]
            );
            
            // Логування
            await AuditService.log({
                userId,
                actionType: 'WIALON_SYNC',
                entityType: 'WIALON_INTEGRATION',
                entityId: settings.id,
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

    // Допоміжний метод для оновлення атрибуту об'єкта
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

    // Шифрування та дешифрування токену
    static encryptToken(token) {
        try {
            // Використовуємо змінні середовища для секретного ключа і IV
            // В реальному додатку ці значення мають бути в .env файлі
            const encryptionKey = process.env.ENCRYPTION_KEY;
            
            // Створюємо шифр
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey.padEnd(32).slice(0, 32)), iv);
            
            // Шифруємо
            let encrypted = cipher.update(token, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            // Повертаємо IV + зашифрований токен
            return iv.toString('hex') + ':' + encrypted;
        } catch (error) {
            console.error('Error encrypting token:', error);
            throw new Error('Помилка шифрування токену');
        }
    }

    static decryptToken(encryptedToken) {
        try {
            // Розбиваємо на IV та шифрований текст
            const parts = encryptedToken.split(':');
            if (parts.length !== 2) {
                throw new Error('Невірний формат зашифрованого токену');
            }
            
            const iv = Buffer.from(parts[0], 'hex');
            const encrypted = parts[1];
            
            // Використовуємо той самий ключ
            const encryptionKey = process.env.ENCRYPTION_KEY || 'mySecretKey12345';
            
            // Створюємо дешифратор
            const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey.padEnd(32).slice(0, 32)), iv);
            
            // Дешифруємо
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            
            return decrypted;
        } catch (error) {
            console.error('Error decrypting token:', error);
            throw new Error('Помилка дешифрування токену');
        }
    }
}

module.exports = WialonIntegrationService;