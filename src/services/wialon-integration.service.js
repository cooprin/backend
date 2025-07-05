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
                        encryptionKey,  // ← Перемістили на 4-е місце
                        data.sync_interval || 60,
                        data.additional_settings ? JSON.stringify(data.additional_settings) : '{}',
                        userId
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

            
            // Формуємо URL для тестового запиту
            const response = await axios.post(`${tokenData.api_url}/wialon/ajax.html`,
                `svc=token/login&params=${encodeURIComponent(JSON.stringify({token: tokenData.decrypted_token}))}`,
                {
                    headers: { 
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'ERP-System/1.0'
                    },
                    timeout: 10000 // 10 секунд таймаут
                });
            
            // Перевіряємо відповідь - виправлена логіка
            if (response.data && response.data.eid && response.data.user) {
                // Успіх - є session ID та дані користувача
                await pool.query('SELECT company.update_wialon_sync_time()');
                
                return {
                    success: true,
                    message: 'Підключення успішне',
                    userData: response.data.user,
                    sessionId: response.data.eid,
                    time: new Date()
                };
            } else if (response.data && response.data.error) {
                // Помилка від Wialon
                console.log('Wialon error code:', response.data.error);
                console.log('Wialon error reason:', response.data.reason);
                
                const errorText = response.data.reason || 'Невідома помилка';
                throw new Error('Помилка авторизації: ' + errorText);
            } else {
                // Неочікувана відповідь
                throw new Error('Неочікувана відповідь від Wialon API');
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
            // Отримуємо ключ шифрування з змінної оточення
            const encryptionKey = process.env.WIALON_ENCRYPTION_KEY;

            
            if (!encryptionKey) {
                throw new Error('WIALON_ENCRYPTION_KEY не встановлено в змінних оточення');
            }
            
            // ПЕРЕДАЄМО КЛЮЧ при читанні токена
            const result = await pool.query('SELECT * FROM company.get_wialon_token($1)', [encryptionKey]);
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            console.error('Error getting wialon token:', error);
            throw error;
        }
    }

    // Отримання інформації про оплату клієнта

static async getClientPaymentStatus(wialonResourceId) {
    try {
        const tokenData = await this.getWialonToken();
        if (!tokenData) {
            return {
                isConfigured: false,
                status: 'unknown',
                daysLeft: null,
                error: 'Wialon integration not configured'
            };
        }

        const axios = require('axios');
        
        // Авторизація в Wialon
        const loginResponse = await axios.post(`${tokenData.api_url}/wialon/ajax.html`, 
            `svc=token/login&params=${encodeURIComponent(JSON.stringify({token: tokenData.decrypted_token}))}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            }
        );

        if (!loginResponse.data || loginResponse.data.error) {
            throw new Error('Wialon authorization failed: ' + 
                (loginResponse.data?.reason || loginResponse.data?.error_text || 'Unknown error'));
        }

        const eid = loginResponse.data.eid;

        try {
            // Отримання інформації про обліковий запис
            const accountUrl = `${tokenData.api_url}/wialon/ajax.html?svc=account/get_account_data&params={"itemId":${wialonResourceId},"type":1}&sid=${eid}`;
            const accountResponse = await axios.get(accountUrl, { timeout: 10000 });

            if (accountResponse.data && !accountResponse.data.error) {
                const accountData = accountResponse.data;
                
                // Визначаємо статус на основі даних з Wialon
                const clientStatus = this.determineClientStatus(accountData);
                
                // СПРОЩЕНА СТРУКТУРА - тільки status і daysLeft
                return {
                    isConfigured: true,
                    status: clientStatus.status,        // active, expiring_soon, expired, blocked, unknown
                    daysLeft: clientStatus.daysLeft     // число або null
                };
            } else {
                throw new Error('Failed to get account data from Wialon');
            }

        } finally {
            // Завжди закриваємо сесію
            try {
                await axios.get(`${tokenData.api_url}/wialon/ajax.html?svc=core/logout&sid=${eid}`, { timeout: 5000 });
            } catch (logoutError) {
                console.error('Error during Wialon logout:', logoutError.message);
            }
        }

    } catch (error) {
        console.error('Error getting client payment status:', error);
        return {
            isConfigured: true,
            status: 'unknown',
            daysLeft: null,
            error: error.message
        };
    }
}
static determineClientStatus(accountData) {
    const {
        enabled,        // 0 - заблокований, 1 - активний
        daysCounter,    // кількість днів до блокування
        parentEnabled   // батьківський акаунт доступний/заблокований
    } = accountData;

    // Перевіряємо чи батьківський акаунт активний
    if (!parentEnabled) {
        return {
            status: 'blocked',
            reason: 'parent_account_blocked',
            daysLeft: 0,
            isActive: false
        };
    }

    // Перевіряємо чи сам акаунт активний
    if (enabled === 0) {
        return {
            status: 'blocked',
            reason: 'account_blocked',
            daysLeft: 0,
            isActive: false
        };
    }

    // Акаунт активний, перевіряємо daysCounter
    if (daysCounter === undefined || daysCounter === null) {
        return {
            status: 'active',
            reason: 'unlimited',
            daysLeft: null,
            isActive: true
        };
    }

    // Визначаємо статус на основі кількості днів
    if (daysCounter > 7) {
        return {
            status: 'active',
            reason: 'paid',
            daysLeft: daysCounter,
            isActive: true
        };
    } else if (daysCounter > 0) {
        return {
            status: 'expiring_soon',
            reason: 'expiring',
            daysLeft: daysCounter,
            isActive: true
        };
    } else {
        return {
            status: 'expired',
            reason: 'days_expired',
            daysLeft: 0,
            isActive: false
        };
    }
}
// Отримання real-time даних об'єктів клієнта
static async getObjectsRealTimeData(clientId) {
    try {
        const { pool } = require('../database');
        
        // Отримання об'єктів клієнта з бази
        const objectsResult = await pool.query(
            'SELECT id, wialon_id, name FROM wialon.objects WHERE client_id = $1 AND status = $2',
            [clientId, 'active']
        );
        
        if (objectsResult.rows.length === 0) {
            return [];
        }
        
        const tokenData = await this.getWialonToken();
        if (!tokenData) {
            throw new Error('Wialon integration not configured');
        }

        const axios = require('axios');
        
        // Авторизація в Wialon
        const loginResponse = await axios.post(`${tokenData.api_url}/wialon/ajax.html`, 
            `svc=token/login&params=${encodeURIComponent(JSON.stringify({token: tokenData.decrypted_token}))}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            }
        );

        if (!loginResponse.data || loginResponse.data.error) {
            throw new Error('Wialon authorization failed');
        }

        const eid = loginResponse.data.eid;

        try {
            const objectsData = [];
            
            for (const object of objectsResult.rows) {
                try {
                    const objectData = await this.getObjectRealTimeInfo(tokenData.api_url, eid, object.wialon_id, object);
                    objectsData.push(objectData);
                } catch (objectError) {
                    console.error(`Error getting data for object ${object.name}:`, objectError);
                    // Додаємо об'єкт з помилкою
                    objectsData.push({
                        objectId: object.id,
                        wialonId: object.wialon_id,
                        name: object.name,
                        error: 'Data unavailable',
                        lastMessage: null,
                        isMoving: false,
                        speed: 0,
                        satellites: 0,
                        address: 'Unknown',
                        last30min: {
                            distance: 0,
                            satelliteChanges: 0,
                            messageCount: 0,
                            speedChart: [],
                            satelliteChart: []
                        }
                    });
                }
            }

            return objectsData;

        } finally {
            // Завжди закриваємо сесію
            try {
                await axios.get(`${tokenData.api_url}/wialon/ajax.html?svc=core/logout&sid=${eid}`, { timeout: 5000 });
            } catch (logoutError) {
                console.error('Error during Wialon logout:', logoutError.message);
            }
        }

    } catch (error) {
        console.error('Error getting objects real-time data:', error);
        throw error;
    }
}

// Допоміжний метод для отримання інформації про конкретний об'єкт
static async getObjectRealTimeInfo(apiUrl, eid, wialonId, objectInfo) {
    const axios = require('axios');
    
    // Отримання поточної позиції об'єкта
    const positionResponse = await axios.get(
        `${apiUrl}/wialon/ajax.html?svc=core/search_item&params=${encodeURIComponent(JSON.stringify({
            id: parseInt(wialonId),
            flags: 1025 // 1 + 1024 для базової інформації + позиції
        }))}&sid=${eid}`,
        { timeout: 10000 }
    );

    if (!positionResponse.data || positionResponse.data.error) {
        throw new Error('Failed to get object position');
    }

    const objectData = positionResponse.data.item;
    const position = objectData.pos || {};
    
    // Розрахунок часу 30 хвилин тому
    const thirtyMinutesAgo = Math.floor(Date.now() / 1000) - (30 * 60);
    const currentTime = Math.floor(Date.now() / 1000);

    console.log(`Loading messages for object ${wialonId} from ${new Date(thirtyMinutesAgo * 1000)} to ${new Date(currentTime * 1000)}`);

    // Отримання повідомлень за останні 30 хвилин - ВИПРАВЛЕНІ ПАРАМЕТРИ
    const messagesUrl = `${apiUrl}/wialon/ajax.html?svc=messages/load_interval&params=${encodeURIComponent(JSON.stringify({
        itemId: parseInt(wialonId),
        timeFrom: thirtyMinutesAgo,
        timeTo: currentTime,
        flags: 0,
        flagsMask: 1, 
        loadCount: 100
    }))}&sid=${eid}`;
    // Логування запиту
    console.log(`=== WIALON REQUEST FOR OBJECT ${wialonId} ===`);
    console.log(`Request URL: ${messagesUrl}`);
    console.log(`Request params:`, {
        itemId: parseInt(wialonId),
        timeFrom: thirtyMinutesAgo,
        timeTo: currentTime,
        timeFromReadable: new Date(thirtyMinutesAgo * 1000).toISOString(),
        timeToReadable: new Date(currentTime * 1000).toISOString(),
        flags: 0,
        flagsMask: 1,
        loadCount: 100
    });

    const messagesResponse = await axios.get(messagesUrl, { timeout: 15000 });

    // Логування відповіді
    console.log(`=== WIALON RESPONSE FOR OBJECT ${wialonId} ===`);
    console.log(`Response status: ${messagesResponse.status}`);
    console.log(`Response data:`, JSON.stringify(messagesResponse.data, null, 2));
    console.log(`=== END RESPONSE ===`); 
    console.log(`Messages response for object ${wialonId}:`, messagesResponse.data);

    let messages = [];
    if (messagesResponse.data && !messagesResponse.data.error) {
        messages = messagesResponse.data.messages || [];
        console.log(`Found ${messages.length} messages for object ${wialonId}`);
    } else {
        console.warn(`No messages or error for object ${wialonId}:`, messagesResponse.data);
        
        // Якщо помилка 1001 (Invalid session), логуємо це
        if (messagesResponse.data?.error === 1001) {
            console.error('Invalid session error - session may have expired');
        }
    }
    
    // Аналіз повідомлень
    const analysis = this.analyzeMessages(messages);
    
    // Геокодування координат
    const address = await this.geocodeCoordinates(position.y, position.x);

    return {
        objectId: objectInfo.id,
        wialonId: objectInfo.wialon_id,
        name: objectInfo.name,
        lastMessage: position.t ? new Date(position.t * 1000).toISOString() : null,
        isMoving: (position.s || 0) > 5, // швидкість більше 5 км/год
        speed: Math.round(position.s || 0),
        satellites: position.sc || 0,
        address: address,
        coordinates: {
            lat: position.y || 0,
            lon: position.x || 0
        },
        last30min: analysis,
        debug: {
            messagesCount: messages.length,
            timeFrom: new Date(thirtyMinutesAgo * 1000).toISOString(),
            timeTo: new Date(currentTime * 1000).toISOString()
        }
    };
}

// Аналіз повідомлень за останні 30 хвилин - ВИПРАВЛЕНО під нову структуру
static analyzeMessages(messages) {
    if (!messages || messages.length === 0) {
        return {
            distance: 0,
            satelliteChanges: 0,
            messageCount: 0,
            speedChart: [],
            satelliteChart: []
        };
    }

    let totalDistance = 0;
    let satelliteChanges = 0;
    let previousSatellites = null;
    const speedChart = [];
    const satelliteChart = [];

    // Сортуємо повідомлення за часом
    messages.sort((a, b) => a.t - b.t);

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const time = new Date(msg.t * 1000);
        const timeStr = time.getHours().toString().padStart(2, '0') + ':' + 
                       time.getMinutes().toString().padStart(2, '0');

        // Перевіряємо чи є позиція в повідомленні
        const position = msg.pos || {};
        const speed = position.s || 0;
        const satellites = position.sc || 0;

        // Графік швидкості (кожні 5 хвилин)
        if (i % Math.max(1, Math.floor(messages.length / 6)) === 0) {
            speedChart.push({
                time: timeStr,
                speed: Math.round(speed)
            });
        }

        // Графік супутників
        if (i % Math.max(1, Math.floor(messages.length / 6)) === 0) {
            satelliteChart.push({
                time: timeStr,
                count: satellites
            });
        }

        // Підрахунок змін супутників
        if (previousSatellites !== null && satellites !== previousSatellites) {
            satelliteChanges++;
        }
        previousSatellites = satellites;

        // Розрахунок відстані
        if (i > 0) {
            const prevMsg = messages[i - 1];
            const prevPosition = prevMsg.pos || {};
            
            if (position.y && position.x && prevPosition.y && prevPosition.x) {
                const distance = this.calculateDistance(
                    prevPosition.y, prevPosition.x,
                    position.y, position.x
                );
                totalDistance += distance;
            }
        }
    }

    return {
        distance: Math.round(totalDistance * 100) / 100, // км з точністю до сотих
        satelliteChanges,
        messageCount: messages.length,
        speedChart: speedChart.slice(-6), // останні 6 точок
        satelliteChart: satelliteChart.slice(-6)
    };
}

// Геокодування координат
static async geocodeCoordinates(lat, lon) {
    if (!lat || !lon) return 'Unknown location';
    
    try {
        const axios = require('axios');
        
        // Використовуємо Nominatim (безкоштовний сервіс OpenStreetMap)
        const response = await axios.get(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
            {
                headers: {
                    'User-Agent': 'ERP-System/1.0'
                },
                timeout: 5000
            }
        );

        if (response.data && response.data.display_name) {
            return response.data.display_name;
        }
        
        return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    } catch (error) {
        console.error('Geocoding error:', error);
        return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    }
}

// Розрахунок відстані між двома точками (Haversine formula)
static calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Радіус Землі в км
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

static toRad(value) {
    return value * Math.PI / 180;
}
}

module.exports = WialonIntegrationService;