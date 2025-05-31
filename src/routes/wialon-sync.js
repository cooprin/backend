const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const WialonSyncService = require('../services/wialon-sync.service');
const AuditService = require('../services/auditService');
const { AUDIT_TYPES } = require('../constants/constants');

// Отримання списку сесій синхронізації
router.get('/sessions', authenticate, checkPermission('wialon_sync.read'), async (req, res) => {
    try {
        const { limit = 20, offset = 0 } = req.query;
        
        const query = `
            SELECT * FROM wialon_sync.view_sync_sessions_full
            ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
        `;
        
        const result = await pool.query(query, [parseInt(limit), parseInt(offset)]);
        
        res.json({
            success: true,
            sessions: result.rows,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                total: result.rows.length
            }
        });
    } catch (error) {
        console.error('Error fetching sync sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні сесій синхронізації'
        });
    }
});

// Отримання деталей конкретної сесії
router.get('/sessions/:sessionId', authenticate, checkPermission('wialon_sync.read'), async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        const sessionQuery = `
            SELECT * FROM wialon_sync.view_sync_sessions_full
            WHERE id = $1
        `;
        
        const logsQuery = `
            SELECT * FROM wialon_sync.sync_logs
            WHERE session_id = $1
            ORDER BY created_at DESC
        `;
        
        const [sessionResult, logsResult] = await Promise.all([
            pool.query(sessionQuery, [sessionId]),
            pool.query(logsQuery, [sessionId])
        ]);
        
        if (sessionResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Сесія синхронізації не знайдена'
            });
        }
        
        res.json({
            success: true,
            session: sessionResult.rows[0],
            logs: logsResult.rows
        });
    } catch (error) {
        console.error('Error fetching sync session details:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні деталей сесії'
        });
    }
});

// Запуск нової синхронізації
router.post('/start', authenticate, checkPermission('wialon_sync.create'), async (req, res) => {
    const client = await pool.connect();
    let sessionId = null;
    
    try {
        await client.query('BEGIN');
        
        // Створення нової сесії
        const session = await WialonSyncService.createSyncSession(req.user.userId);
        sessionId = session.id;
        
        await WialonSyncService.addSyncLog(sessionId, 'info', 'Sync session started by user', {
            userId: req.user.userId,
            userEmail: req.user.email
        });
        
        // Очищення попередніх тимчасових даних
        await WialonSyncService.clearTempTables(sessionId);
        
        // Завантаження даних з Wialon
        const loadStats = await WialonSyncService.loadDataFromWialon(sessionId);
        
        // Аналіз розбіжностей
        const discrepanciesCount = await WialonSyncService.analyzeDiscrepancies(
            client, 
            sessionId, 
            req.user.userId
        );
        
        // Завершення сесії
        const completedSession = await WialonSyncService.completeSyncSession(sessionId, {
            clientsChecked: loadStats.clientsLoaded,
            objectsChecked: loadStats.objectsLoaded,
            discrepanciesFound: discrepanciesCount
        });
        
        await client.query('COMMIT');
        
        // Аудит
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'WIALON_SYNC_START',
            entityType: 'SYNC_SESSION',
            entityId: sessionId,
            newValues: {
                clientsLoaded: loadStats.clientsLoaded,
                objectsLoaded: loadStats.objectsLoaded,
                discrepanciesFound: discrepanciesCount
            },
            ipAddress: req.ip,
            tableSchema: 'wialon_sync',
            tableName: 'sync_sessions',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        res.json({
            success: true,
            session: completedSession,
            stats: {
                clientsLoaded: loadStats.clientsLoaded,
                objectsLoaded: loadStats.objectsLoaded,
                discrepanciesFound: discrepanciesCount
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        
        if (sessionId) {
            await WialonSyncService.failSyncSession(sessionId, error.message);
        }
        
        console.error('Error during sync:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при синхронізації з Wialon',
            sessionId: sessionId
        });
    } finally {
        client.release();
    }
});

// Отримання списку розбіжностей
router.get('/discrepancies', authenticate, checkPermission('wialon_sync.read'), async (req, res) => {
    try {
        const { 
            sessionId, 
            status, 
            discrepancyType,
            limit = 50, 
            offset = 0 
        } = req.query;
        
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
        
        if (discrepancyType) {
            query += ` AND discrepancy_type = $${paramIndex++}`;
            params.push(discrepancyType);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        params.push(parseInt(limit), parseInt(offset));
        
        const result = await pool.query(query, params);
        
        // Отримання статистики
        const statsQuery = `
            SELECT 
                status,
                discrepancy_type,
                COUNT(*) as count
            FROM wialon_sync.sync_discrepancies
            WHERE 1=1
            ${sessionId ? 'AND session_id = $1' : ''}
            GROUP BY status, discrepancy_type
            ORDER BY status, discrepancy_type
        `;
        
        const statsResult = await pool.query(
            statsQuery, 
            sessionId ? [sessionId] : []
        );
        
        res.json({
            success: true,
            discrepancies: result.rows,
            stats: statsResult.rows,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                total: result.rows.length
            }
        });
    } catch (error) {
        console.error('Error fetching discrepancies:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні розбіжностей'
        });
    }
});

// Вирішення розбіжностей (масове оновлення)
router.post('/discrepancies/resolve', authenticate, checkPermission('wialon_sync.update'), async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { discrepancyIds, action, notes } = req.body;
        
        if (!discrepancyIds || !Array.isArray(discrepancyIds) || discrepancyIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Не вказано розбіжності для вирішення'
            });
        }
        
        if (!['approved', 'ignored', 'rejected'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Невірна дія для вирішення розбіжностей'
            });
        }
        
        // Оновлення статусу розбіжностей
        const updateQuery = `
            UPDATE wialon_sync.sync_discrepancies
            SET status = $1,
                resolution_notes = $2,
                resolved_by = $3,
                resolved_at = CURRENT_TIMESTAMP
            WHERE id = ANY($4::uuid[])
            AND status = 'pending'
            RETURNING *
        `;
        
        const result = await client.query(updateQuery, [
            action,
            notes || null,
            req.user.userId,
            discrepancyIds
        ]);
        
        // Якщо дія "схвалено", додаємо записи до основних таблиць
        if (action === 'approved') {
            await this.processApprovedDiscrepancies(client, result.rows, req.user.userId);
        }
        
        await client.query('COMMIT');
        
        // Аудит
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'WIALON_SYNC_RESOLVE',
            entityType: 'SYNC_DISCREPANCY',
            entityId: discrepancyIds.join(','),
            newValues: {
                action,
                notes,
                resolvedCount: result.rowCount
            },
            ipAddress: req.ip,
            tableSchema: 'wialon_sync',
            tableName: 'sync_discrepancies',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        res.json({
            success: true,
            message: `Успішно вирішено ${result.rowCount} розбіжностей`,
            resolvedCount: result.rowCount,
            discrepancies: result.rows
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resolving discrepancies:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при вирішенні розбіжностей'
        });
    } finally {
        client.release();
    }
});

// Обробка схвалених розбіжностей
async function processApprovedDiscrepancies(client, discrepancies, userId) {
    for (const discrepancy of discrepancies) {
        try {
            switch (discrepancy.discrepancy_type) {
                case 'new_client':
                    await addNewClient(client, discrepancy, userId);
                    break;
                    
                case 'new_object':
                case 'new_object_with_known_client':
                    await addNewObject(client, discrepancy, userId);
                    break;
                    
                case 'client_name_changed':
                    await updateClientName(client, discrepancy);
                    break;
                    
                case 'object_name_changed':
                    await updateObjectName(client, discrepancy);
                    break;
                    
                case 'owner_changed':
                    await updateObjectOwner(client, discrepancy);
                    break;
            }
        } catch (error) {
            console.error(`Error processing discrepancy ${discrepancy.id}:`, error);
            // Продовжуємо обробку інших розбіжностей
        }
    }
}

// Додавання нового клієнта
async function addNewClient(client, discrepancy, userId) {
    const wialonData = discrepancy.wialon_entity_data;
    
    await client.query(`
        INSERT INTO clients.clients (wialon_id, name, full_name, description, is_active)
        VALUES ($1, $2, $3, $4, true)
    `, [
        wialonData.wialon_id,
        wialonData.name,
        wialonData.full_name || wialonData.name,
        wialonData.description
    ]);
}

// Додавання нового об'єкта
async function addNewObject(client, discrepancy, userId) {
    const wialonData = discrepancy.wialon_entity_data;
    let clientId = discrepancy.suggested_client_id;
    
    // Якщо немає пропонованого клієнта, спробуємо знайти за owner_wialon_id
    if (!clientId && wialonData.owner_wialon_id) {
        const clientResult = await client.query(
            'SELECT id FROM clients.clients WHERE wialon_id = $1',
            [wialonData.owner_wialon_id]
        );
        
        if (clientResult.rows.length > 0) {
            clientId = clientResult.rows[0].id;
        }
    }
    
    if (!clientId) {
        throw new Error('Не знайдено клієнта для об\'єкта');
    }
    
    await client.query(`
        INSERT INTO wialon.objects (wialon_id, name, description, client_id, status)
        VALUES ($1, $2, $3, $4, 'active')
    `, [
        wialonData.wialon_id,
        wialonData.name,
        wialonData.description,
        clientId
    ]);
}

// Оновлення назви клієнта
async function updateClientName(client, discrepancy) {
    const wialonData = discrepancy.wialon_entity_data;
    
    await client.query(`
        UPDATE clients.clients 
        SET name = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
    `, [
        wialonData.name,
        discrepancy.system_client_id
    ]);
}

// Оновлення назви об'єкта
async function updateObjectName(client, discrepancy) {
    const wialonData = discrepancy.wialon_entity_data;
    
    await client.query(`
        UPDATE wialon.objects 
        SET name = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
    `, [
        wialonData.name,
        discrepancy.system_object_id
    ]);
}

// Оновлення власника об'єкта
async function updateObjectOwner(client, discrepancy) {
    if (!discrepancy.suggested_client_id) {
        throw new Error('Не вказано нового власника об\'єкта');
    }
    
    await client.query(`
        UPDATE wialon.objects 
        SET client_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
    `, [
        discrepancy.suggested_client_id,
        discrepancy.system_object_id
    ]);
}

// Отримання налаштувань синхронізації
router.get('/rules', authenticate, checkPermission('wialon_sync.read'), async (req, res) => {
    try {
        const query = `
            SELECT * FROM wialon_sync.view_sync_rules_active
            ORDER BY execution_order, name
        `;
        
        const result = await pool.query(query);
        
        res.json({
            success: true,
            rules: result.rows
        });
    } catch (error) {
        console.error('Error fetching sync rules:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні правил синхронізації'
        });
    }
});

// Оновлення правил синхронізації
router.put('/rules/:ruleId', authenticate, checkPermission('wialon_sync.update'), async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { ruleId } = req.params;
        const { name, description, sql_query, parameters, execution_order, is_active } = req.body;
        
        const query = `
            UPDATE wialon_sync.sync_rules
            SET name = $1,
                description = $2,
                sql_query = $3,
                parameters = $4,
                execution_order = $5,
                is_active = $6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7
            RETURNING *
        `;
        
        const result = await client.query(query, [
            name,
            description,
            sql_query,
            parameters ? JSON.stringify(parameters) : null,
            execution_order,
            is_active,
            ruleId
        ]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Правило синхронізації не знайдено'
            });
        }
        
        await client.query('COMMIT');
        
        // Аудит
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'SYNC_RULE_UPDATE',
            entityType: 'SYNC_RULE',
            entityId: ruleId,
            newValues: req.body,
            ipAddress: req.ip,
            tableSchema: 'wialon_sync',
            tableName: 'sync_rules',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        res.json({
            success: true,
            rule: result.rows[0]
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating sync rule:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні правила синхронізації'
        });
    } finally {
        client.release();
    }
});

module.exports = router;