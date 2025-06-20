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
            throw new Error('Wialon integration not configured');
        }

        const axios = require('axios');
        
        // Авторизація в Wialon
        const loginResponse = await axios.post(`${tokenData.api_url}/wialon/ajax.html`, 
            `svc=token/login&params=${encodeURIComponent(JSON.stringify({token: tokenData.decrypted_token}))}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        );

        if (!loginResponse.data || loginResponse.data.error) {
            throw new Error('Wialon authorization failed: ' + 
                (loginResponse.data?.reason || loginResponse.data?.error_text || 'Unknown error'));
        }

        const eid = loginResponse.data.eid;

        // Отримання інформації про обліковий запис - використовуємо wialon_resource_id
        const accountUrl = `${tokenData.api_url}/wialon/ajax.html?svc=account/get_account_data&params={"itemId":${wialonResourceId},"type":1}&sid=${eid}`;
        const accountResponse = await axios.get(accountUrl);

        let paymentInfo = {
            isConfigured: true,
            hasWialonResourceId: true,
            status: 'unknown',
            daysLeft: null,
            isActive: false,
            reason: null
        };

        if (accountResponse.data && !accountResponse.data.error) {
            const accountData = accountResponse.data;
            
            // Визначаємо статус на основі даних з Wialon
            const clientStatus = this.determineClientStatus(accountData);
            
            paymentInfo = {
                ...paymentInfo,
                status: clientStatus.status,
                daysLeft: clientStatus.daysLeft,
                isActive: clientStatus.isActive,
                reason: clientStatus.reason,
                // Додаткова інформація з Wialon
                plan: accountData.plan || null,
                parentAccountName: accountData.parentAccountName || null,
                created: accountData.created ? new Date(accountData.created * 1000) : null
            };
        }

        return paymentInfo;

    } catch (error) {
        console.error('Error getting client payment status:', error);
        return {
            isConfigured: false,
            hasWialonResourceId: true,
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
}

module.exports = WialonIntegrationService;