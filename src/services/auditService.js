const { pool } = require('../database');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

class AuditService {
    static async log({ 
        userId, 
        actionType, 
        entityType, 
        entityId, 
        oldValues = null, 
        newValues = null, 
        ipAddress,
        browserInfo = null,
        userAgent = null,
        tableSchema = null,
        tableName = null,
        auditType = AUDIT_TYPES.BUSINESS,
        details = null,
        req = null  // Додаємо параметр req
    }) {
        try {
            // Формуємо зміни
            const changes = oldValues && newValues ? 
                this.calculateChanges(oldValues, newValues) : null;

            // Формуємо інформацію про браузер з req, якщо вона не передана
            let formattedBrowserInfo = browserInfo;
            if (req && !browserInfo) {
                formattedBrowserInfo = {
                    userAgent: req.headers['user-agent'],
                    platform: req.headers['sec-ch-ua-platform'],
                    mobile: req.headers['sec-ch-ua-mobile'],
                    language: req.headers['accept-language'],
                    referer: req.headers['referer'],
                    browser: getBrowserInfo(req.headers['user-agent'])
                };
            }

            // Перевіряємо та форматуємо browserInfo
            formattedBrowserInfo = formattedBrowserInfo ? 
                (typeof formattedBrowserInfo === 'string' ? 
                    JSON.parse(formattedBrowserInfo) : 
                    formattedBrowserInfo) : 
                null;

            const { rows } = await pool.query(
                `INSERT INTO audit.audit_logs
                 (user_id, action_type, entity_type, entity_id, 
                  old_values, new_values, changes, ip_address,
                  browser_info, user_agent, table_schema, table_name,
                  audit_type)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING id`,
                [
                    userId,
                    actionType,
                    entityType,
                    entityId?.toString(),
                    oldValues ? JSON.stringify(oldValues) : null,
                    newValues ? JSON.stringify(newValues) : null,
                    changes ? JSON.stringify(changes) : null,
                    ipAddress || (req?.ip),
                    formattedBrowserInfo ? JSON.stringify(formattedBrowserInfo) : null,
                    userAgent || req?.headers['user-agent'],
                    tableSchema,
                    tableName,
                    auditType
                ]
            );

            console.log(`Audit log created: ${actionType} by user ${userId}`);
            return rows[0];
        } catch (error) {
            console.error('Error creating audit log:', error);
            return null;
        }
    }

    static calculateChanges(oldValues, newValues) {
        const changes = {};
        const allKeys = new Set([...Object.keys(oldValues || {}), ...Object.keys(newValues || {})]);

        for (const key of allKeys) {
            const oldValue = oldValues?.[key];
            const newValue = newValues?.[key];

            if (oldValue !== newValue) {
                changes[key] = {
                    old: oldValue,
                    new: newValue
                };
            }
        }

        return Object.keys(changes).length > 0 ? changes : null;
    }

    static async logAuth(success, userId, email, ipAddress, req = null) {
        return this.log({
            userId: userId || null,
            actionType: success ? AUDIT_LOG_TYPES.AUTH.LOGIN : AUDIT_LOG_TYPES.AUTH.LOGIN_FAILED,
            entityType: ENTITY_TYPES.USER,
            entityId: userId || null,
            newValues: { email },
            ipAddress,
            req,
            tableSchema: 'auth',
            tableName: 'users',
            auditType: AUDIT_TYPES.BUSINESS
        });
    }

    static async logLogout(userId, ipAddress, req = null) {
        return this.log({
            userId,
            actionType: AUDIT_LOG_TYPES.AUTH.LOGOUT,
            entityType: ENTITY_TYPES.USER,
            entityId: userId,
            ipAddress,
            req,
            tableSchema: 'auth',
            tableName: 'users',
            auditType: AUDIT_TYPES.BUSINESS
        });
    }

    static async logError(userId, error, entityType = null, entityId = null, details = null, req = null) {
        return this.log({
            userId,
            actionType: AUDIT_LOG_TYPES.SYSTEM.ERROR,
            entityType: entityType || ENTITY_TYPES.SYSTEM,
            entityId: entityId,
            newValues: {
                error: error.message,
                stack: error.stack,
                details
            },
            req,
            auditType: AUDIT_TYPES.SYSTEM
        });
    }
}

// Допоміжна функція для отримання інформації про браузер
function getBrowserInfo(userAgent) {
    if (!userAgent) return { name: 'unknown', version: 'unknown' };

    let name = 'unknown';
    let version = 'unknown';

    if (userAgent.includes('Firefox')) {
        name = 'Firefox';
        const match = userAgent.match(/Firefox\/([0-9.]+)/);
        if (match) version = match[1];
    } else if (userAgent.includes('Chrome')) {
        name = 'Chrome';
        const match = userAgent.match(/Chrome\/([0-9.]+)/);
        if (match) version = match[1];
    } else if (userAgent.includes('Safari')) {
        name = 'Safari';
        const match = userAgent.match(/Version\/([0-9.]+)/);
        if (match) version = match[1];
    } else if (userAgent.includes('Edge')) {
        name = 'Edge';
        const match = userAgent.match(/Edge\/([0-9.]+)/);
        if (match) version = match[1];
    }

    return { name, version };
}

module.exports = AuditService;