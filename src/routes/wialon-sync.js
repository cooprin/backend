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
        const { 
            page = 1,
            perPage = 20,
            sortBy = 'start_time',
            descending = true,
            search 
        } = req.query;
        
        let query = `
            SELECT * FROM wialon_sync.view_sync_sessions_full
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        // Додати пошук
        if (search) {
            query += ` AND (
                id::text ILIKE $${paramIndex} OR
                status ILIKE $${paramIndex} OR
                created_by_name ILIKE $${paramIndex}
            )`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        // Сортування
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
        query += ` ORDER BY ${sortBy} ${orderDirection}`;
        
        // Пагінація
        const limit = parseInt(perPage);
        const offset = (parseInt(page) - 1) * limit;
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
        
        // Запит на загальну кількість
        let countQuery = `
            SELECT COUNT(*) as total FROM wialon_sync.view_sync_sessions_full
            WHERE 1=1
        `;
        
        const countParams = [];
        if (search) {
            countQuery += ` AND (
                id::text ILIKE $1 OR
                status ILIKE $1 OR
                created_by_name ILIKE $1
            )`;
            countParams.push(`%${search}%`);
        }
        
        const [sessionsResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, countParams)
        ]);
        
        res.json({
            success: true,
            sessions: sessionsResult.rows,
            total: parseInt(countResult.rows[0].total),
            pagination: {
                page: parseInt(page),
                perPage: limit,
                total: parseInt(countResult.rows[0].total)
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

// Отримання логів синхронізації - ВИПРАВЛЕНО
router.get('/logs', authenticate, checkPermission('wialon_sync.read'), async (req, res) => {
    try {
        const { 
            sessionId, 
            level, 
            dateFrom, 
            dateTo,
            search,
            sortBy = 'created_at',
            descending = true,
            page = 1,
            perPage = 50
        } = req.query;
        
        let query = `
            SELECT 
                sl.*,
                ss.id as session_id,
                ss.created_by,
                u.email as created_by_email
            FROM wialon_sync.sync_logs sl
            JOIN wialon_sync.sync_sessions ss ON sl.session_id = ss.id
            LEFT JOIN auth.users u ON ss.created_by = u.id
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        // Фільтр по сесії
        if (sessionId) {
            query += ` AND sl.session_id = $${paramIndex++}`;
            params.push(sessionId);
        }
        
        // Фільтр по рівню логу
        if (level) {
            query += ` AND sl.log_level = $${paramIndex++}`;
            params.push(level);
        }
        
        // Фільтр по даті від
        if (dateFrom) {
            query += ` AND sl.created_at >= $${paramIndex++}`;
            params.push(dateFrom + ' 00:00:00');
        }
        
        // Фільтр по даті до
        if (dateTo) {
            query += ` AND sl.created_at <= $${paramIndex++}`;
            params.push(dateTo + ' 23:59:59');
        }
        
        // Пошук
        if (search) {
            query += ` AND (
                sl.message ILIKE $${paramIndex} OR
                sl.log_level ILIKE $${paramIndex}
            )`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        // Отримання загальної кількості ПЕРЕД пагінацією
        let countQuery = `
            SELECT COUNT(*) as total
            FROM wialon_sync.sync_logs sl
            JOIN wialon_sync.sync_sessions ss ON sl.session_id = ss.id
            WHERE 1=1
        `;
        
        const countParams = [...params]; // Копіюємо параметри
        
        const countResult = await pool.query(countQuery.replace(/JOIN wialon_sync\.sync_sessions ss ON sl\.session_id = ss\.id/, 'JOIN wialon_sync.sync_sessions ss ON sl.session_id = ss.id').replace(/sl\./g, 'sl.').replace(/ss\./g, 'ss.'), countParams.slice(0, -1));
        const totalCount = parseInt(countResult.rows[0].total);
        
        // Сортування
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
        query += ` ORDER BY sl.${sortBy} ${orderDirection}`;
        
        // Пагінація - ВИПРАВЛЕНО
        const limit = parseInt(perPage);
        const offset = (parseInt(page) - 1) * limit;
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
        
        const logsResult = await pool.query(query, params);
        
        // Статистика по рівням логів (БЕЗ пагінації)
        let statsQuery = `
            SELECT 
                log_level,
                COUNT(*) as count
            FROM wialon_sync.sync_logs sl
            JOIN wialon_sync.sync_sessions ss ON sl.session_id = ss.id
            WHERE 1=1
        `;
        
        const statsParams = [];
        let statsParamIndex = 1;
        
        if (sessionId) {
            statsQuery += ` AND sl.session_id = $${statsParamIndex++}`;
            statsParams.push(sessionId);
        }
        
        if (level) {
            statsQuery += ` AND sl.log_level = $${statsParamIndex++}`;
            statsParams.push(level);
        }
        
        if (dateFrom) {
            statsQuery += ` AND sl.created_at >= $${statsParamIndex++}`;
            statsParams.push(dateFrom + ' 00:00:00');
        }
        
        if (dateTo) {
            statsQuery += ` AND sl.created_at <= $${statsParamIndex++}`;
            statsParams.push(dateTo + ' 23:59:59');
        }
        
        if (search) {
            statsQuery += ` AND (
                sl.message ILIKE $${statsParamIndex} OR
                sl.log_level ILIKE $${statsParamIndex}
            )`;
            statsParams.push(`%${search}%`);
            statsParamIndex++;
        }
        
        statsQuery += ` GROUP BY log_level ORDER BY log_level`;
        
        const statsResult = await pool.query(statsQuery, statsParams);
        
        res.json({
            success: true,
            logs: logsResult.rows,
            total: totalCount,
            stats: statsResult.rows,
            pagination: {
                page: parseInt(page),
                perPage: limit,
                total: totalCount,
                hasMore: (parseInt(page) * limit) < totalCount
            }
        });
    } catch (error) {
        console.error('Error fetching sync logs:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні логів синхронізації'
        });
    }
});

// Очищення логів синхронізації
router.delete('/logs', authenticate, checkPermission('wialon_sync.delete'), async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { sessionId, olderThan } = req.body;
        
        let deleteQuery = 'DELETE FROM wialon_sync.sync_logs WHERE 1=1';
        const params = [];
        let paramIndex = 1;
        
        // Видалити логи конкретної сесії
        if (sessionId) {
            deleteQuery += ` AND session_id = $${paramIndex++}`;
            params.push(sessionId);
        }
        
        // Видалити логи старші за вказану дату
        if (olderThan) {
            deleteQuery += ` AND created_at < $${paramIndex++}`;
            params.push(olderThan);
        }
        
        const result = await client.query(deleteQuery, params);
        
        await client.query('COMMIT');
        
        // Аудит
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'WIALON_SYNC_LOGS_CLEAR',
            entityType: 'SYNC_LOGS',
            entityId: sessionId || 'all',
            newValues: {
                deletedCount: result.rowCount,
                sessionId,
                olderThan
            },
            ipAddress: req.ip,
            tableSchema: 'wialon_sync',
            tableName: 'sync_logs',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        res.json({
            success: true,
            message: `Видалено ${result.rowCount} записів логів`,
            deletedCount: result.rowCount
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error clearing sync logs:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при очищенні логів синхронізації'
        });
    } finally {
        client.release();
    }
});

// Запуск нової синхронізації - ОНОВЛЕНО для використання createSyncSessionSafe
router.post('/start', authenticate, checkPermission('wialon_sync.create'), async (req, res) => {
    const client = await pool.connect();
    let sessionId = null;
    
    try {
        await client.query('BEGIN');
        
        // Створення нової сесії з безпечною перевіркою
        const session = await WialonSyncService.createSyncSessionSafe(req.user.userId);
        sessionId = session.id;
        
        await WialonSyncService.addSyncLog(sessionId, 'info', 'Sync session started by user', {
            userId: req.user.userId,
            userEmail: req.user.email
        });
        
        // Очищення попередніх тимчасових даних
        await WialonSyncService.clearTempTables(sessionId);
        
        // Завантаження даних з Wialon
        const loadStats = await WialonSyncService.loadDataFromWialon(sessionId);
        
        // Аналіз розбіжностей через динамічні правила
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
                discrepanciesFound: discrepanciesCount,
                syncMethod: 'dynamic_rules'
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

// Отримання списку розбіжностей - ВИПРАВЛЕНО
router.get('/discrepancies', authenticate, checkPermission('wialon_sync.read'), async (req, res) => {
    try {
        const { 
            sessionId, 
            status, 
            type,
            search,
            sortBy = 'created_at',
            descending = true,
            page = 1,
            perPage = 50
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
        
        if (type) {
            query += ` AND discrepancy_type = $${paramIndex++}`;
            params.push(type);
        }
        
        if (search) {
            query += ` AND (
                discrepancy_type ILIKE $${paramIndex} OR
                (wialon_entity_data->>'name') ILIKE $${paramIndex} OR
                (system_entity_data->>'name') ILIKE $${paramIndex}
            )`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        // Запит на загальну кількість ПЕРЕД пагінацією
        let countQuery = query.replace('SELECT * FROM', 'SELECT COUNT(*) as total FROM');
        const countResult = await pool.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].total);
        
        // Сортування
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
        query += ` ORDER BY ${sortBy} ${orderDirection}`;
        
        // Пагінація - ВИПРАВЛЕНО
        const limit = parseInt(perPage);
        const offset = (parseInt(page) - 1) * limit;
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
        
        const discrepanciesResult = await pool.query(query, params);
        
        // Отримання повної статистики (БЕЗ фільтрів пагінації)
        let statsQuery = `
            SELECT 
                status,
                COUNT(*) as count
            FROM wialon_sync.sync_discrepancies
            WHERE 1=1
        `;
        
        const statsParams = [];
        let statsParamIndex = 1;
        
        // Додаємо ті ж фільтри що і для основного запиту (крім пагінації)
        if (sessionId) {
            statsQuery += ` AND session_id = $${statsParamIndex++}`;
            statsParams.push(sessionId);
        }
        
        if (status) {
            statsQuery += ` AND status = $${statsParamIndex++}`;
            statsParams.push(status);
        }
        
        if (type) {
            statsQuery += ` AND discrepancy_type = $${statsParamIndex++}`;
            statsParams.push(type);
        }
        
        if (search) {
            statsQuery += ` AND (
                discrepancy_type ILIKE $${statsParamIndex} OR
                (wialon_entity_data->>'name') ILIKE $${statsParamIndex} OR
                (system_entity_data->>'name') ILIKE $${statsParamIndex}
            )`;
            statsParams.push(`%${search}%`);
            statsParamIndex++;
        }
        
        statsQuery += ` GROUP BY status ORDER BY status`;
        
        const statsResult = await pool.query(statsQuery, statsParams);
        
        res.json({
            success: true,
            discrepancies: discrepanciesResult.rows,
            total: totalCount,
            stats: statsResult.rows,
            pagination: {
                page: parseInt(page),
                perPage: limit,
                total: totalCount
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

// Отримання правил синхронізації
router.get('/rules', authenticate, checkPermission('wialon_sync.read'), async (req, res) => {
    try {
        const {
            type,
            activeOnly,
            search,
            sortBy = 'execution_order',
            descending = false,
            page = 1,
            perPage = 20
        } = req.query;
        
        let query = `
            SELECT * FROM wialon_sync.view_sync_rules_active
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        if (type) {
            query += ` AND rule_type = $${paramIndex++}`;
            params.push(type);
        }
        
        if (activeOnly === 'true') {
            query += ` AND is_active = true`;
        }
        
        if (search) {
            query += ` AND (
                name ILIKE $${paramIndex} OR
                description ILIKE $${paramIndex} OR
                rule_type ILIKE $${paramIndex}
            )`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        // Сортування
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
        query += ` ORDER BY ${sortBy} ${orderDirection}`;
        
        // Пагінація
        const limit = parseInt(perPage);
        const offset = (parseInt(page) - 1) * limit;
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
        
        // Запит на загальну кількість
        let countQuery = `
            SELECT COUNT(*) as total FROM wialon_sync.view_sync_rules_active
            WHERE 1=1
        `;
        
        const countParams = [];
        let countParamIndex = 1;
        
        if (type) {
            countQuery += ` AND rule_type = $${countParamIndex++}`;
            countParams.push(type);
        }
        
        if (activeOnly === 'true') {
            countQuery += ` AND is_active = true`;
        }
        
        if (search) {
            countQuery += ` AND (
                name ILIKE $${countParamIndex} OR
                description ILIKE $${countParamIndex} OR
                rule_type ILIKE $${countParamIndex}
            )`;
            countParams.push(`%${search}%`);
            countParamIndex++;
        }
        
        const [rulesResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, countParams)
        ]);
        
        res.json({
            success: true,
            rules: rulesResult.rows,
            total: parseInt(countResult.rows[0].total),
            pagination: {
                page: parseInt(page),
                perPage: limit,
                total: parseInt(countResult.rows[0].total)
            }
        });
    } catch (error) {
        console.error('Error fetching sync rules:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні правил синхронізації'
        });
    }
});

// Створення нового правила синхронізації
router.post('/rules', authenticate, checkPermission('wialon_sync.create'), async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { name, description, rule_type, sql_query, parameters, execution_order, is_active } = req.body;
        
        const query = `
            INSERT INTO wialon_sync.sync_rules
            (name, description, rule_type, sql_query, parameters, execution_order, is_active, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `;
        
        const result = await client.query(query, [
            name,
            description,
            rule_type,
            sql_query,
            parameters ? JSON.stringify(parameters) : null,
            execution_order || 1,
            is_active !== undefined ? is_active : true,
            req.user.userId
        ]);
        
        await client.query('COMMIT');
        
        // Аудит
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'SYNC_RULE_CREATE',
            entityType: 'SYNC_RULE',
            entityId: result.rows[0].id,
            newValues: req.body,
            ipAddress: req.ip,
            tableSchema: 'wialon_sync',
            tableName: 'sync_rules',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        res.status(201).json({
            success: true,
            rule: result.rows[0]
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating sync rule:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні правила синхронізації'
        });
    } finally {
        client.release();
    }
});

// Оновлення правил синхронізації
router.put('/rules/:ruleId', authenticate, checkPermission('wialon_sync.update'), async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { ruleId } = req.params;
        const { name, description, sql_query, parameters, execution_order, is_active } = req.body;
        
        delete req.body.id;
        delete req.body.created_by_email;
        delete req.body.created_by_name;  
        delete req.body.total_executions;
        delete req.body.last_execution;
        delete req.body.created_at;
        delete req.body.updated_at;
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

// Видалення правила синхронізації
router.delete('/rules/:ruleId', authenticate, checkPermission('wialon_sync.delete'), async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { ruleId } = req.params;
        
        // Отримання даних правила для аудиту
        const ruleData = await client.query('SELECT * FROM wialon_sync.sync_rules WHERE id = $1', [ruleId]);
        
        if (ruleData.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Правило синхронізації не знайдено'
            });
        }
        
        // Видалення правила
await client.query('DELETE FROM wialon_sync.sync_rules WHERE id = $1', [ruleId]);
        
        await client.query('COMMIT');
        
        // Аудит
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'SYNC_RULE_DELETE',
            entityType: 'SYNC_RULE',
            entityId: ruleId,
            oldValues: ruleData.rows[0],
            ipAddress: req.ip,
            tableSchema: 'wialon_sync',
            tableName: 'sync_rules',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        res.json({
            success: true,
            message: 'Правило синхронізації успішно видалено'
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting sync rule:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні правила синхронізації'
        });
    } finally {
        client.release();
    }
});

// Виконання конкретного правила
router.post('/rules/:ruleId/execute', authenticate, checkPermission('wialon_sync.update'), async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { ruleId } = req.params;
        
        // Отримання правила
        const ruleResult = await client.query(
            'SELECT * FROM wialon_sync.sync_rules WHERE id = $1 AND is_active = true',
            [ruleId]
        );
        
        if (ruleResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Активне правило синхронізації не знайдено'
            });
        }
        
        const rule = ruleResult.rows[0];
        
        // Виконання SQL запиту правила
        const executionResult = await client.query(rule.sql_query, rule.parameters ? Object.values(rule.parameters) : []);
        
        // Запис виконання правила
        await client.query(`
            INSERT INTO wialon_sync.sync_rule_executions (rule_id, executed_by, execution_result)
            VALUES ($1, $2, $3)
        `, [
            ruleId,
            req.user.userId,
            JSON.stringify({
                rowCount: executionResult.rowCount,
                rows: executionResult.rows
            })
        ]);
        
        await client.query('COMMIT');
        
        // Аудит
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'SYNC_RULE_EXECUTE',
            entityType: 'SYNC_RULE',
            entityId: ruleId,
            newValues: {
                ruleName: rule.name,
                executionResult: executionResult.rowCount
            },
            ipAddress: req.ip,
            tableSchema: 'wialon_sync',
            tableName: 'sync_rule_executions',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        res.json({
            success: true,
            message: `Правило "${rule.name}" успішно виконано`,
            result: {
                rowCount: executionResult.rowCount,
                ruleName: rule.name
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error executing sync rule:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при виконанні правила синхронізації'
        });
    } finally {
        client.release();
    }
});

module.exports = router;