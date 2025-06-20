const { pool } = require('../database');
const AuditService = require('./auditService');
const WialonIntegrationService = require('./wialon-integration.service');
const { AUDIT_TYPES } = require('../constants/constants');

class WialonSyncService {
    // Безпечне створення нової сесії синхронізації з перевіркою concurrent
    static async createSyncSessionSafe(userId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Очищення зависших сесій перед створенням нової
            await client.query('SELECT wialon_sync.cleanup_stale_sessions()');
            
            // Atomic перевірка існуючих активних сесій
            const activeCheck = await client.query(`
                SELECT id FROM wialon_sync.sync_sessions 
                WHERE status = 'running' 
                FOR UPDATE
            `);
            
            if (activeCheck.rows.length > 0) {
                throw new Error('Синхронізація вже виконується. Дочекайтеся завершення поточної сесії.');
            }
            
            // Створення нової сесії
            const result = await client.query(`
                INSERT INTO wialon_sync.sync_sessions (created_by, status)
                VALUES ($1, 'running')
                RETURNING id, start_time, status
            `, [userId]);
            
            await client.query('COMMIT');
            return result.rows[0];
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error creating sync session:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Завершення сесії синхронізації
    static async completeSyncSession(sessionId, stats = {}) {
        try {
            const query = `
                UPDATE wialon_sync.sync_sessions 
                SET end_time = CURRENT_TIMESTAMP,
                    status = 'completed',
                    total_clients_checked = $2,
                    total_objects_checked = $3,
                    discrepancies_found = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING *
            `;
            
            const result = await pool.query(query, [
                sessionId,
                stats.clientsChecked || 0,
                stats.objectsChecked || 0,
                stats.discrepanciesFound || 0
            ]);
            
            return result.rows[0];
        } catch (error) {
            console.error('Error completing sync session:', error);
            throw error;
        }
    }

    // Помітка сесії як невдалої
    static async failSyncSession(sessionId, errorMessage) {
        try {
            const query = `
                UPDATE wialon_sync.sync_sessions 
                SET end_time = CURRENT_TIMESTAMP,
                    status = 'failed',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `;
            
            await pool.query(query, [sessionId]);

            // Логування помилки
            await this.addSyncLog(sessionId, 'error', 'Sync session failed', { error: errorMessage });
        } catch (error) {
            console.error('Error failing sync session:', error);
            throw error;
        }
    }

    // Додавання запису до логів синхронізації
    static async addSyncLog(sessionId, level, message, details = null) {
        try {
            const query = `
                INSERT INTO wialon_sync.sync_logs (session_id, log_level, message, details)
                VALUES ($1, $2, $3, $4)
            `;
            
            await pool.query(query, [
                sessionId,
                level,
                message,
                details ? JSON.stringify(details) : null
            ]);
        } catch (error) {
            console.error('Error adding sync log:', error);
        }
    }

    // Очищення тимчасових таблиць
    static async clearTempTables(sessionId) {
        try {
            await pool.query('DELETE FROM wialon_sync.temp_wialon_clients WHERE session_id = $1', [sessionId]);
            await pool.query('DELETE FROM wialon_sync.temp_wialon_objects WHERE session_id = $1', [sessionId]);
        } catch (error) {
            console.error('Error clearing temp tables:', error);
        }
    }

    // Завантаження активних правил синхронізації
    static async getActiveRules(client) {
        try {
            const query = `
                SELECT id, name, description, rule_type, sql_query, parameters, execution_order
                FROM wialon_sync.sync_rules
                WHERE is_active = true
                ORDER BY execution_order ASC, name ASC
            `;
            
            const result = await client.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error loading active sync rules:', error);
            throw error;
        }
    }

    // Виконання окремого правила синхронізації
    static async executeRule(client, sessionId, rule, userId) {
        const executionStart = Date.now();
        let discrepanciesCount = 0;
        
        try {
            await this.addSyncLog(sessionId, 'info', `Executing rule: ${rule.name}`, {
                ruleId: rule.id,
                ruleType: rule.rule_type,
                executionOrder: rule.execution_order
            });

            // Логування початку виконання правила
            const executionRecord = await client.query(`
                INSERT INTO wialon_sync.sync_rule_executions 
                (session_id, rule_id, execution_start, status)
                VALUES ($1, $2, CURRENT_TIMESTAMP, 'running')
                RETURNING id
            `, [sessionId, rule.id]);

            const executionId = executionRecord.rows[0].id;

            // Підготовка параметрів для SQL-запиту
            const sqlParams = [sessionId]; // Перший параметр завжди sessionId
            
            // Додавання додаткових параметрів з rule.parameters якщо потрібно
            if (rule.parameters && typeof rule.parameters === 'object') {
                // Тут можна додати логіку для додаткових параметрів в майбутньому
            }

            // Виконання SQL-запиту правила
            const result = await client.query(rule.sql_query, sqlParams);
            discrepanciesCount = result.rowCount || 0;

            const executionEnd = Date.now();
            const duration = (executionEnd - executionStart) / 1000;

            // Оновлення запису виконання правила
            await client.query(`
                UPDATE wialon_sync.sync_rule_executions
                SET execution_end = CURRENT_TIMESTAMP,
                    status = 'completed',
                    records_processed = $3,
                    discrepancies_found = $4,
                    execution_details = $5
                WHERE id = $1 AND rule_id = $2
            `, [
                executionId,
                rule.id,
                0, // records_processed - для майбутнього використання
                discrepanciesCount,
                JSON.stringify({
                    duration_seconds: duration,
                    sql_row_count: result.rowCount,
                    completed_at: new Date().toISOString()
                })
            ]);

            await this.addSyncLog(sessionId, 'info', `Rule completed: ${rule.name}`, {
                ruleId: rule.id,
                discrepanciesFound: discrepanciesCount,
                durationSeconds: duration
            });

            return discrepanciesCount;

        } catch (error) {
            const executionEnd = Date.now();
            const duration = (executionEnd - executionStart) / 1000;

            // Оновлення запису виконання правила з помилкою
            await client.query(`
                UPDATE wialon_sync.sync_rule_executions
                SET execution_end = CURRENT_TIMESTAMP,
                    status = 'failed',
                    error_message = $3,
                    execution_details = $4
                WHERE session_id = $1 AND rule_id = $2 AND status = 'running'
            `, [
                sessionId,
                rule.id,
                error.message,
                JSON.stringify({
                    duration_seconds: duration,
                    error_details: error.stack,
                    failed_at: new Date().toISOString()
                })
            ]);

            await this.addSyncLog(sessionId, 'error', `Rule failed: ${rule.name}`, {
                ruleId: rule.id,
                error: error.message,
                durationSeconds: duration
            });

            throw error;
        }
    }

    // Завантаження даних з Wialon API
    static async loadDataFromWialon(sessionId) {
        try {
            await this.addSyncLog(sessionId, 'info', 'Starting data load from Wialon');

            const tokenData = await WialonIntegrationService.getWialonToken();
            if (!tokenData) {
                throw new Error('Wialon integration not configured');
            }

            // Авторизація в Wialon
            const loginUrl = `${tokenData.api_url}/wialon/ajax.html?svc=token/login&params={"token":"${tokenData.decrypted_token}"}`;
            const axios = require('axios');
            const loginResponse = await axios.get(loginUrl);

            if (!loginResponse.data || loginResponse.data.error) {
                throw new Error('Wialon authorization failed: ' + 
                    (loginResponse.data?.reason || loginResponse.data?.error_text || 'Unknown error'));
            }

            const eid = loginResponse.data.eid;
            await this.addSyncLog(sessionId, 'info', 'Wialon authorization successful', { eid });

            // Завантаження клієнтів
            const clientsCount = await this.loadClientsFromWialon(sessionId, tokenData.api_url, eid);

            // Завантаження об'єктів
            const objectsCount = await this.loadObjectsFromWialon(sessionId, tokenData.api_url, eid);

            await this.addSyncLog(sessionId, 'info', 'Data load completed', {
                clientsLoaded: clientsCount,
                objectsLoaded: objectsCount
            });

            return { clientsLoaded: clientsCount, objectsLoaded: objectsCount };
        } catch (error) {
            await this.addSyncLog(sessionId, 'error', 'Failed to load data from Wialon', { error: error.message });
            throw error;
        }
    }

// Завантаження клієнтів з Wialon
static async loadClientsFromWialon(sessionId, apiUrl, eid) {
    try {
        const axios = require('axios');
        
        const searchUrl = `${apiUrl}/wialon/ajax.html?svc=core/search_items&params={"spec":{"itemsType":"avl_resource","propName":"sys_name","propValueMask":"*","sortType":"sys_name"},"force":1,"flags":5,"from":0,"to":0}&sid=${eid}`;
        
        const response = await axios.get(searchUrl);

        if (!response.data || response.data.error) {
            throw new Error('Failed to fetch clients from Wialon: ' + 
                (response.data?.reason || response.data?.error_text || 'Unknown error'));
        }

        const clients = response.data.items || [];
        let insertedCount = 0;
        let usernamesFetched = 0;

        const client = await pool.connect();
        try {
            for (const wialonClient of clients) {
                let wialonUsername = null;
                
                try {
                    const detailUrl = `${apiUrl}/wialon/ajax.html?svc=core/search_item&params={"id":${wialonClient.crt},"flags":1}&sid=${eid}`;
                    const detailResponse = await axios.get(detailUrl);
                    
                    if (detailResponse.data && !detailResponse.data.error && detailResponse.data.item) {
                        wialonUsername = detailResponse.data.item.nm || null;
                        if (wialonUsername) {
                            usernamesFetched++;
                        }
                        
                        await this.addSyncLog(sessionId, 'debug', `Fetched username for client ${wialonClient.nm}`, {
                            clientCrt: wialonClient.crt,
                            clientResourceId: wialonClient.id,
                            username: wialonUsername
                        });
                    } else {
                        await this.addSyncLog(sessionId, 'warning', `Failed to fetch username for client ${wialonClient.nm}`, {
                            clientCrt: wialonClient.crt,
                            clientResourceId: wialonClient.id,
                            error: detailResponse.data?.error_text || 'No item data'
                        });
                    }
                } catch (usernameError) {
                    await this.addSyncLog(sessionId, 'warning', `Error fetching username for client ${wialonClient.nm}`, {
                        clientCrt: wialonClient.crt,
                        clientResourceId: wialonClient.id,
                        error: usernameError.message
                    });
                }

                await client.query(`
                    INSERT INTO wialon_sync.temp_wialon_clients 
                    (session_id, wialon_resource_id, wialon_user_id, name, full_name, description, wialon_username, additional_data)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [
                    sessionId,
                    wialonClient.id?.toString() || null, // Resource ID для біллінгу
                    wialonClient.crt?.toString() || null, // User ID для авторизації
                    wialonClient.nm || 'Unknown Client',
                    wialonClient.nm || null,
                    wialonClient.desc || null,
                    wialonUsername,
                    JSON.stringify(wialonClient)
                ]);
                insertedCount++;
            }
        } finally {
            client.release();
        }

        await this.addSyncLog(sessionId, 'info', `Loaded ${insertedCount} clients from Wialon`, {
            totalClients: insertedCount,
            usernamesFetched: usernamesFetched,
            usernamesNotFetched: insertedCount - usernamesFetched
        });
        
        return insertedCount;
    } catch (error) {
        await this.addSyncLog(sessionId, 'error', 'Failed to load clients', { error: error.message });
        throw error;
    }
}

    // Завантаження об'єктів з Wialon
    static async loadObjectsFromWialon(sessionId, apiUrl, eid) {
        try {
            const axios = require('axios');
            
            const searchUrl = `${apiUrl}/wialon/ajax.html?svc=core/search_items&params={"spec":{"itemsType":"avl_unit","propName":"sys_name","propValueMask":"*","sortType":"sys_name"},"force":1,"flags":257,"from":0,"to":0}&sid=${eid}`;
            
            const response = await axios.get(searchUrl);

            if (!response.data || response.data.error) {
                throw new Error('Failed to fetch objects from Wialon: ' + 
                    (response.data?.reason || response.data?.error_text || 'Unknown error'));
            }

            const objects = response.data.items || [];
            let insertedCount = 0;

            const client = await pool.connect();
            try {
                for (const wialonObject of objects) {
                    const phones = this.extractPhoneNumbers(wialonObject);
                    const trackerId = this.extractTrackerId(wialonObject);

                    await client.query(`
                        INSERT INTO wialon_sync.temp_wialon_objects 
                        (session_id, wialon_id, name, description, tracker_id, phone_numbers, additional_data)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [
                        sessionId,
                        wialonObject.id.toString(),
                        wialonObject.nm || 'Unknown Object',
                        wialonObject.desc || null,
                        trackerId,
                        JSON.stringify(phones),
                        JSON.stringify(wialonObject)
                    ]);
                    insertedCount++;
                }
            } finally {
                client.release();
            }

            await this.addSyncLog(sessionId, 'info', `Loaded ${insertedCount} objects from Wialon`);
            return insertedCount;
        } catch (error) {
            await this.addSyncLog(sessionId, 'error', 'Failed to load objects', { error: error.message });
            throw error;
        }
    }

    // Динамічний аналіз розбіжностей через правила з БД
    static async analyzeDiscrepancies(client, sessionId, userId) {
        try {
            await this.addSyncLog(sessionId, 'info', 'Starting dynamic discrepancy analysis using database rules');

            // Завантаження активних правил
            const rules = await this.getActiveRules(client);
            
            if (rules.length === 0) {
                await this.addSyncLog(sessionId, 'warning', 'No active sync rules found. Skipping discrepancy analysis.');
                return 0;
            }

            await this.addSyncLog(sessionId, 'info', `Found ${rules.length} active sync rules`, {
                ruleNames: rules.map(r => r.name)
            });

            let totalDiscrepancies = 0;

            // Виконання кожного правила по порядку
            for (const rule of rules) {
                try {
                    const discrepanciesCount = await this.executeRule(client, sessionId, rule, userId);
                    totalDiscrepancies += discrepanciesCount;
                } catch (ruleError) {
                    await this.addSyncLog(sessionId, 'error', `Failed to execute rule: ${rule.name}`, {
                        ruleId: rule.id,
                        error: ruleError.message
                    });
                    // Продовжуємо виконання інших правил навіть якщо одне не спрацювало
                }
            }

            await this.addSyncLog(sessionId, 'info', `Dynamic discrepancy analysis completed. Found ${totalDiscrepancies} discrepancies using ${rules.length} rules`);
            
            return totalDiscrepancies;
        } catch (error) {
            await this.addSyncLog(sessionId, 'error', 'Dynamic discrepancy analysis failed', { error: error.message });
            throw error;
        }
    }

    // Отримання списку розбіжностей
    static async getDiscrepancies(sessionId = null, status = null, limit = 100, offset = 0) {
        try {
            let query = `
                SELECT * FROM wialon_sync.view_sync_discrepancies_full
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (sessionId) {
                query += ` AND session_id = $${paramIndex++}`;
                params.push(sessionId);
            }

            if (status) {
                query += ` AND status = $${paramIndex++}`;
                params.push(status);
            }

            query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
            params.push(limit, offset);

            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error getting discrepancies:', error);
            throw error;
        }
    }

    // Допоміжні методи для парсингу даних Wialon
    static extractPhoneNumbers(wialonObject) {
        const phones = [];
        try {
            if (wialonObject.phone) {
                phones.push(wialonObject.ph);
            }
        } catch (error) {
            console.error('Error extracting phone numbers:', error);
        }
        return phones;
    }

    static extractTrackerId(wialonObject) {
        try {
            return wialonObject.trackerId || wialonObject.uid || null;
        } catch (error) {
            console.error('Error extracting tracker ID:', error);
            return null;
        }
    }
}

module.exports = WialonSyncService;