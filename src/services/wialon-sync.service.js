const { pool } = require('../database');
const AuditService = require('./auditService');
const WialonIntegrationService = require('./wialon-integration.service');
const { AUDIT_TYPES } = require('../constants/constants');

class WialonSyncService {
    // Створення нової сесії синхронізації
    static async createSyncSession(userId) {
        try {
            const query = `
                INSERT INTO wialon_sync.sync_sessions (created_by)
                VALUES ($1)
                RETURNING id, start_time, status
            `;
            
            const result = await pool.query(query, [userId]);
            return result.rows[0];
        } catch (error) {
            console.error('Error creating sync session:', error);
            throw error;
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

            // ВИПРАВЛЕНО: перевірка на наявність помилки замість error !== 0
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
            
            // Отримуємо список користувачів (клієнтів)
            const searchUrl = `${apiUrl}/wialon/ajax.html?svc=core/search_items&params={"spec":{"itemsType":"user","propName":"sys_name","propValueMask":"*","sortType":"sys_name"},"force":1,"flags":1,"from":0,"to":0}&sid=${eid}`;
            
            const response = await axios.get(searchUrl);

            // ВИПРАВЛЕНО: перевірка на наявність помилки замість error !== 0
            if (!response.data || response.data.error) {
                throw new Error('Failed to fetch clients from Wialon: ' + 
                    (response.data?.reason || response.data?.error_text || 'Unknown error'));
            }

            const clients = response.data.items || [];
            let insertedCount = 0;

            const client = await pool.connect();
            try {
                for (const wialonClient of clients) {
                    await client.query(`
                        INSERT INTO wialon_sync.temp_wialon_clients 
                        (session_id, wialon_id, name, full_name, description, additional_data)
                        VALUES ($1, $2, $3, $4, $5, $6)
                    `, [
                        sessionId,
                        wialonClient.id.toString(),
                        wialonClient.nm || 'Unknown Client',
                        wialonClient.nm || null,
                        wialonClient.desc || null,
                        JSON.stringify(wialonClient)
                    ]);
                    insertedCount++;
                }
            } finally {
                client.release();
            }

            await this.addSyncLog(sessionId, 'info', `Loaded ${insertedCount} clients from Wialon`);
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
            
            // Отримуємо список об'єктів
            const searchUrl = `${apiUrl}/wialon/ajax.html?svc=core/search_items&params={"spec":{"itemsType":"avl_unit","propName":"sys_name","propValueMask":"*","sortType":"sys_name"},"force":1,"flags":1025,"from":0,"to":0}&sid=${eid}`;
            
            const response = await axios.get(searchUrl);

            // ВИПРАВЛЕНО: перевірка на наявність помилки замість error !== 0
            if (!response.data || response.data.error) {
                throw new Error('Failed to fetch objects from Wialon: ' + 
                    (response.data?.reason || response.data?.error_text || 'Unknown error'));
            }

            const objects = response.data.items || [];
            let insertedCount = 0;

            const client = await pool.connect();
            try {
                for (const wialonObject of objects) {
                    // Отримуємо додаткову інформацію про об'єкт
                    const phones = this.extractPhoneNumbers(wialonObject);
                    const trackerId = this.extractTrackerId(wialonObject);

                    await client.query(`
                        INSERT INTO wialon_sync.temp_wialon_objects 
                        (session_id, wialon_id, name, description, owner_wialon_id, tracker_id, phone_numbers, additional_data)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    `, [
                        sessionId,
                        wialonObject.id.toString(),
                        wialonObject.nm || 'Unknown Object',
                        wialonObject.desc || null,
                        wialonObject.creatorId?.toString() || null,
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

    // Аналіз розбіжностей
    static async analyzeDiscrepancies(client, sessionId, userId) {
        try {
            await this.addSyncLog(sessionId, 'info', 'Starting discrepancy analysis');

            let totalDiscrepancies = 0;

            // Аналіз нових клієнтів
            totalDiscrepancies += await this.findNewClients(client, sessionId);

            // Аналіз нових об'єктів
            totalDiscrepancies += await this.findNewObjects(client, sessionId);

            // Аналіз змін назв клієнтів
            totalDiscrepancies += await this.findClientNameChanges(client, sessionId);

            // Аналіз змін назв об'єктів
            totalDiscrepancies += await this.findObjectNameChanges(client, sessionId);

            // Аналіз змін власників об'єктів
            totalDiscrepancies += await this.findOwnershipChanges(client, sessionId);

            await this.addSyncLog(sessionId, 'info', `Discrepancy analysis completed. Found ${totalDiscrepancies} discrepancies`);
            return totalDiscrepancies;
        } catch (error) {
            await this.addSyncLog(sessionId, 'error', 'Discrepancy analysis failed', { error: error.message });
            throw error;
        }
    }

    // Пошук нових клієнтів
    static async findNewClients(client, sessionId) {
        try {
            const query = `
                INSERT INTO wialon_sync.sync_discrepancies 
                (session_id, discrepancy_type, entity_type, wialon_entity_data, status)
                SELECT 
                    $1,
                    'new_client',
                    'client',
                    jsonb_build_object(
                        'wialon_id', twc.wialon_id,
                        'name', twc.name,
                        'full_name', twc.full_name,
                        'description', twc.description
                    ),
                    'pending'
                FROM wialon_sync.temp_wialon_clients twc
                WHERE twc.session_id = $1
                AND NOT EXISTS (
                    SELECT 1 FROM clients.clients c 
                    WHERE c.wialon_id = twc.wialon_id
                )
            `;

            const result = await client.query(query, [sessionId]);
            return result.rowCount;
        } catch (error) {
            console.error('Error finding new clients:', error);
            return 0;
        }
    }

    // Пошук нових об'єктів
    static async findNewObjects(client, sessionId) {
        try {
            const query = `
                INSERT INTO wialon_sync.sync_discrepancies 
                (session_id, discrepancy_type, entity_type, wialon_entity_data, suggested_client_id, suggested_action, status)
                SELECT 
                    $1,
                    CASE 
                        WHEN c.id IS NOT NULL THEN 'new_object_with_known_client'
                        ELSE 'new_object'
                    END,
                    'object',
                    jsonb_build_object(
                        'wialon_id', two.wialon_id,
                        'name', two.name,
                        'description', two.description,
                        'owner_wialon_id', two.owner_wialon_id,
                        'tracker_id', two.tracker_id,
                        'phone_numbers', two.phone_numbers
                    ),
                    c.id,
                    CASE 
                        WHEN c.id IS NOT NULL THEN 'assign_to_existing_client'
                        ELSE NULL
                    END,
                    'pending'
                FROM wialon_sync.temp_wialon_objects two
                LEFT JOIN clients.clients c ON two.owner_wialon_id = c.wialon_id
                WHERE two.session_id = $1
                AND NOT EXISTS (
                    SELECT 1 FROM wialon.objects o 
                    WHERE o.wialon_id = two.wialon_id
                )
            `;

            const result = await client.query(query, [sessionId]);
            return result.rowCount;
        } catch (error) {
            console.error('Error finding new objects:', error);
            return 0;
        }
    }

    // Пошук змін назв клієнтів
    static async findClientNameChanges(client, sessionId) {
        try {
            const query = `
                INSERT INTO wialon_sync.sync_discrepancies 
                (session_id, discrepancy_type, entity_type, system_client_id, wialon_entity_data, system_entity_data, status)
                SELECT 
                    $1,
                    'client_name_changed',
                    'client',
                    c.id,
                    jsonb_build_object(
                        'wialon_id', twc.wialon_id,
                        'name', twc.name
                    ),
                    jsonb_build_object(
                        'id', c.id,
                        'name', c.name,
                        'wialon_id', c.wialon_id
                    ),
                    'pending'
                FROM wialon_sync.temp_wialon_clients twc
                JOIN clients.clients c ON twc.wialon_id = c.wialon_id
                WHERE twc.session_id = $1
                AND LOWER(TRIM(twc.name)) != LOWER(TRIM(c.name))
            `;

            const result = await client.query(query, [sessionId]);
            return result.rowCount;
        } catch (error) {
            console.error('Error finding client name changes:', error);
            return 0;
        }
    }

    // Пошук змін назв об'єктів
    static async findObjectNameChanges(client, sessionId) {
        try {
            const query = `
                INSERT INTO wialon_sync.sync_discrepancies 
                (session_id, discrepancy_type, entity_type, system_object_id, wialon_entity_data, system_entity_data, status)
                SELECT 
                    $1,
                    'object_name_changed',
                    'object',
                    o.id,
                    jsonb_build_object(
                        'wialon_id', two.wialon_id,
                        'name', two.name
                    ),
                    jsonb_build_object(
                        'id', o.id,
                        'name', o.name,
                        'wialon_id', o.wialon_id
                    ),
                    'pending'
                FROM wialon_sync.temp_wialon_objects two
                JOIN wialon.objects o ON two.wialon_id = o.wialon_id
                WHERE two.session_id = $1
                AND LOWER(TRIM(two.name)) != LOWER(TRIM(o.name))
            `;

            const result = await client.query(query, [sessionId]);
            return result.rowCount;
        } catch (error) {
            console.error('Error finding object name changes:', error);
            return 0;
        }
    }

    // Пошук змін власників об'єктів
    static async findOwnershipChanges(client, sessionId) {
        try {
            const query = `
                INSERT INTO wialon_sync.sync_discrepancies 
                (session_id, discrepancy_type, entity_type, system_object_id, suggested_client_id, wialon_entity_data, system_entity_data, suggested_action, status)
                SELECT 
                    $1,
                    'owner_changed',
                    'object',
                    o.id,
                    c_wialon.id,
                    jsonb_build_object(
                        'wialon_id', two.wialon_id,
                        'name', two.name,
                        'owner_wialon_id', two.owner_wialon_id
                    ),
                    jsonb_build_object(
                        'id', o.id,
                        'name', o.name,
                        'current_client_id', o.client_id,
                        'current_client_name', c_current.name
                    ),
                    'change_owner',
                    'pending'
                FROM wialon_sync.temp_wialon_objects two
                JOIN wialon.objects o ON two.wialon_id = o.wialon_id
                JOIN clients.clients c_current ON o.client_id = c_current.id
                LEFT JOIN clients.clients c_wialon ON two.owner_wialon_id = c_wialon.wialon_id
                WHERE two.session_id = $1
                AND c_current.wialon_id != two.owner_wialon_id
                AND c_wialon.id IS NOT NULL
            `;

            const result = await client.query(query, [sessionId]);
            return result.rowCount;
        } catch (error) {
            console.error('Error finding ownership changes:', error);
            return 0;
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
            // Логіка витягування номерів телефонів з об'єкта Wialon
            // Це залежить від структури даних Wialon
            if (wialonObject.phone) {
                phones.push(wialonObject.phone);
            }
        } catch (error) {
            console.error('Error extracting phone numbers:', error);
        }
        return phones;
    }

    static extractTrackerId(wialonObject) {
        try {
            // Логіка витягування ID трекера з об'єкта Wialon
            return wialonObject.trackerId || wialonObject.uid || null;
        } catch (error) {
            console.error('Error extracting tracker ID:', error);
            return null;
        }
    }
}

module.exports = WialonSyncService;