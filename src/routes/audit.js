const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { pool } = require('../database');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const AuditService = require('../services/auditService');

// Get audit logs with enhanced filtering
router.get('/', authenticate, checkPermission('audit.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'created_at',
            descending = true,
            actionType,
            entityType,
            auditType,
            dateFrom,
            dateTo,
            search,
            userId,
            ipAddress,
            tableSchema,
            tableName,
            hasChanges
        } = req.query;

        if (perPage === 'All') {
            perPage = null;
        } else {
            perPage = parseInt(perPage);
            page = parseInt(page);
        }
        
        const offset = (page - 1) * (perPage || 0);
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                COALESCE(u.email, '') ILIKE $${paramIndex} OR 
                COALESCE(al.action_type, '') ILIKE $${paramIndex} OR 
                COALESCE(al.entity_type, '') ILIKE $${paramIndex} OR
                COALESCE(al.table_name, '') ILIKE $${paramIndex} OR
                COALESCE(al.ip_address::text, '') ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (actionType) {
            conditions.push(`al.action_type = $${paramIndex}`);
            params.push(actionType);
            paramIndex++;
        }

        if (entityType) {
            conditions.push(`al.entity_type = $${paramIndex}`);
            params.push(entityType);
            paramIndex++;
        }

        if (auditType) {
            conditions.push(`al.audit_type = $${paramIndex}`);
            params.push(auditType);
            paramIndex++;
        }

        if (dateFrom) {
            conditions.push(`al.created_at >= $${paramIndex}::timestamp`);
            params.push(dateFrom);
            paramIndex++;
        }

        if (dateTo) {
            conditions.push(`al.created_at < ($${paramIndex}::timestamp + interval '1 day')`);
            params.push(dateTo);
            paramIndex++;
        }

        if (userId) {
            conditions.push(`al.user_id = $${paramIndex}`);
            params.push(userId);
            paramIndex++;
        }

        if (ipAddress) {
            conditions.push(`al.ip_address = $${paramIndex}::inet`);
            params.push(ipAddress);
            paramIndex++;
        }

        if (tableSchema) {
            conditions.push(`al.table_schema = $${paramIndex}`);
            params.push(tableSchema);
            paramIndex++;
        }

        if (tableName) {
            conditions.push(`al.table_name = $${paramIndex}`);
            params.push(tableName);
            paramIndex++;
        }

        if (hasChanges === 'true') {
            conditions.push('al.changes IS NOT NULL');
        } else if (hasChanges === 'false') {
            conditions.push('al.changes IS NULL');
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        const baseQuery = `
            FROM audit.audit_logs al
            LEFT JOIN auth.users u ON al.user_id = u.id
            ${whereClause}
        `;

        const countQuery = `SELECT COUNT(*) ${baseQuery}`;

        let logsQuery = `
            SELECT 
                al.id,
                al.user_id,
                al.action_type,
                al.entity_type,
                al.entity_id,
                al.old_values,
                al.new_values,
                al.changes,
                al.ip_address,
                al.browser_info,
                al.user_agent,
                al.table_schema,
                al.table_name,
                al.audit_type,
                al.created_at,
                u.email as user_email
            ${baseQuery}
            ORDER BY al.${sortBy} ${orderDirection}
        `;

        if (perPage) {
            logsQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(perPage, offset);
        }

        const [countResult, logsResult] = await Promise.all([
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : []),
            pool.query(logsQuery, params)
        ]);

        const logs = logsResult.rows.map(log => ({
            ...log,
            created_at: log.created_at.toISOString()
        }));

        res.json({
            success: true,
            logs,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching audit logs:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching audit logs'
        });
    }
});

// Export to Excel
router.get('/export', authenticate, checkPermission('audit.read'), async (req, res) => {
    try {
        const { 
            actionType,
            entityType,
            auditType,
            dateFrom,
            dateTo,
            search,
            userId,
            ipAddress,
            tableSchema,
            tableName,
            hasChanges
        } = req.query;

        const browserInfo = {
            userAgent: req.headers['user-agent'],
            platform: req.headers['sec-ch-ua-platform'],
            mobile: req.headers['sec-ch-ua-mobile']
        };

        // Логуємо початок експорту
        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.AUDIT.EXPORT,
            entityType: ENTITY_TYPES.AUDIT_LOG,
            ipAddress: req.ip,
            browserInfo, // Передаємо об'єкт
            userAgent: req.headers['user-agent'],
            newValues: {
                filters: {
                    actionType,
                    entityType,
                    auditType,
                    dateFrom,
                    dateTo,
                    search,
                    userId,
                    ipAddress,
                    tableSchema,
                    tableName,
                    hasChanges
                }
            },
            tableSchema: 'audit',
            tableName: 'audit_logs',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        // Додаємо умови фільтрації
        if (search) {
            conditions.push(`(
                COALESCE(u.email, '') ILIKE $${paramIndex} OR 
                COALESCE(al.action_type, '') ILIKE $${paramIndex} OR 
                COALESCE(al.entity_type, '') ILIKE $${paramIndex} OR
                COALESCE(al.table_name, '') ILIKE $${paramIndex} OR
                COALESCE(al.ip_address::text, '') ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (actionType) {
            conditions.push(`al.action_type = $${paramIndex}`);
            params.push(actionType);
            paramIndex++;
        }

        if (entityType) {
            conditions.push(`al.entity_type = $${paramIndex}`);
            params.push(entityType);
            paramIndex++;
        }

        if (auditType) {
            conditions.push(`al.audit_type = $${paramIndex}`);
            params.push(auditType);
            paramIndex++;
        }

        if (dateFrom) {
            conditions.push(`al.created_at >= $${paramIndex}::timestamp`);
            params.push(dateFrom);
            paramIndex++;
        }

        if (dateTo) {
            conditions.push(`al.created_at < ($${paramIndex}::timestamp + interval '1 day')`);
            params.push(dateTo);
            paramIndex++;
        }

        if (userId) {
            conditions.push(`al.user_id = $${paramIndex}`);
            params.push(userId);
            paramIndex++;
        }

        if (ipAddress) {
            conditions.push(`al.ip_address = $${paramIndex}::inet`);
            params.push(ipAddress);
            paramIndex++;
        }

        if (tableSchema) {
            conditions.push(`al.table_schema = $${paramIndex}`);
            params.push(tableSchema);
            paramIndex++;
        }

        if (tableName) {
            conditions.push(`al.table_name = $${paramIndex}`);
            params.push(tableName);
            paramIndex++;
        }

        if (hasChanges === 'true') {
            conditions.push('al.changes IS NOT NULL');
        } else if (hasChanges === 'false') {
            conditions.push('al.changes IS NULL');
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        const query = `
            SELECT 
                al.created_at,
                u.email as user_email,
                al.action_type,
                al.entity_type,
                al.entity_id,
                al.table_schema,
                al.table_name,
                al.ip_address,
                al.audit_type,
                al.old_values,
                al.new_values,
                al.changes,
                al.browser_info,
                al.user_agent
            FROM audit.audit_logs al
            LEFT JOIN auth.users u ON al.user_id = u.id
            ${whereClause}
            ORDER BY al.created_at DESC
        `;

        const { rows } = await pool.query(query, params);

        // Створюємо новий документ Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Audit Logs');

        // Встановлюємо заголовки
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 20 },
            { header: 'User', key: 'user', width: 30 },
            { header: 'Action', key: 'action', width: 20 },
            { header: 'Entity Type', key: 'entityType', width: 15 },
            { header: 'Entity ID', key: 'entityId', width: 36 },
            { header: 'Schema', key: 'schema', width: 15 },
            { header: 'Table', key: 'table', width: 20 },
            { header: 'IP Address', key: 'ip', width: 15 },
            { header: 'Audit Type', key: 'auditType', width: 15 },
            { header: 'Changes', key: 'changes', width: 50 },
            { header: 'Browser Info', key: 'browserInfo', width: 30 },
            { header: 'User Agent', key: 'userAgent', width: 50 }
        ];

        // Додаємо дані
        rows.forEach(row => {
            worksheet.addRow({
                date: new Date(row.created_at).toLocaleString(),
                user: row.user_email,
                action: row.action_type,
                entityType: row.entity_type,
                entityId: row.entity_id,
                schema: row.table_schema,
                table: row.table_name,
                ip: row.ip_address,
                auditType: row.audit_type,
                changes: row.changes ? JSON.stringify(row.changes, null, 2) : '',
                browserInfo: row.browser_info ? JSON.stringify(row.browser_info, null, 2) : '',
                userAgent: row.user_agent
            });
        });

        // Стилізуємо заголовки
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        // Встановлюємо автофільтр
        worksheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: worksheet.columns.length }
        };

        // Налаштовуємо форматування для довгих текстових полів
        worksheet.columns.forEach(column => {
            if (['changes', 'browserInfo', 'userAgent'].includes(column.key)) {
                column.alignment = { wrapText: true, vertical: 'top' };
            }
        });

        // Встановлюємо заголовки відповіді
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=audit-logs-${new Date().toISOString().slice(0,10)}.xlsx`
        );

        // Відправляємо файл
        await workbook.xlsx.write(res);
        res.end();
        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.AUDIT.EXPORT_SUCCESS,
            entityType: ENTITY_TYPES.AUDIT_LOG,
            ipAddress: req.ip,
            browserInfo, // Передаємо об'єкт
            userAgent: req.headers['user-agent'],
            newValues: { 
                recordsCount: rows.length,
                exportDate: new Date().toISOString()
            },
            tableSchema: 'audit',
            tableName: 'audit_logs',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

    } catch (error) {
        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.AUDIT.EXPORT_ERROR,
            entityType: ENTITY_TYPES.AUDIT_LOG,
            ipAddress: req.ip,
            browserInfo, // Передаємо об'єкт
            userAgent: req.headers['user-agent'],
            newValues: { 
                error: error.message,
                stackTrace: error.stack
            },
            tableSchema: 'audit',
            tableName: 'audit_logs',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        console.error('Error exporting audit logs:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while exporting audit logs'
        });
    }
});

// Get types for filters
router.get('/types', authenticate, checkPermission('audit.read'), async (req, res) => {
    try {
        const [actionTypes, entityTypes, auditTypes, schemas] = await Promise.all([
            pool.query('SELECT DISTINCT action_type FROM audit.audit_logs WHERE action_type IS NOT NULL ORDER BY action_type'),
            pool.query('SELECT DISTINCT entity_type FROM audit.audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type'),
            pool.query('SELECT DISTINCT audit_type FROM audit.audit_logs WHERE audit_type IS NOT NULL ORDER BY audit_type'),
            pool.query('SELECT DISTINCT table_schema FROM audit.audit_logs WHERE table_schema IS NOT NULL ORDER BY table_schema')
        ]);

        // Get tables for each schema
        const schemasWithTables = await Promise.all(
            schemas.rows.map(async ({ table_schema }) => {
                const tables = await pool.query(
                    'SELECT DISTINCT table_name FROM audit.audit_logs WHERE table_schema = $1 ORDER BY table_name',
                    [table_schema]
                );
                return {
                    schema: table_schema,
                    tables: tables.rows.map(row => row.table_name)
                };
            })
        );

        res.json({
            success: true,
            actionTypes: actionTypes.rows.map(row => row.action_type),
            entityTypes: entityTypes.rows.map(row => row.entity_type),
            auditTypes: auditTypes.rows.map(row => row.audit_type),
            schemas: schemasWithTables
        });
    } catch (error) {
        console.error('Error fetching log types:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching log types'
        });
    }
});

module.exports = router;