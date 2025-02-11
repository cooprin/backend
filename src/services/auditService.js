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
        details = null
    }) {
        try {
            // Формуємо changes - порівнюємо old і new values
            const changes = oldValues && newValues ? 
                this.calculateChanges(oldValues, newValues) : null;

            // Перевіряємо та форматуємо browserInfo
            const formattedBrowserInfo = browserInfo ? 
                (typeof browserInfo === 'string' ? JSON.parse(browserInfo) : browserInfo) : 
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
                    entityId?.toString(), // Конвертуємо ID в string
                    oldValues ? JSON.stringify(oldValues) : null,
                    newValues ? JSON.stringify(newValues) : null,
                    changes ? JSON.stringify(changes) : null,
                    ipAddress,
                    formattedBrowserInfo,
                    userAgent,
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

    // Метод для розрахунку змін між старими та новими значеннями
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

    // Розширений метод для логування авторизації
    static async logAuth(success, userId, email, ipAddress, browserInfo = null, userAgent = null) {
        return this.log({
            userId: userId || null,
            actionType: success ? AUDIT_LOG_TYPES.AUTH.LOGIN : AUDIT_LOG_TYPES.AUTH.LOGIN_FAILED,
            entityType: ENTITY_TYPES.USER,
            entityId: userId || null,
            newValues: { email },
            ipAddress,
            browserInfo,
            userAgent,
            tableSchema: 'auth',
            tableName: 'users',
            auditType: AUDIT_TYPES.BUSINESS
        });
    }

    // Розширений метод для логування виходу
    static async logLogout(userId, ipAddress, browserInfo = null, userAgent = null) {
        return this.log({
            userId,
            actionType: AUDIT_LOG_TYPES.AUTH.LOGOUT,
            entityType: ENTITY_TYPES.USER,
            entityId: userId,
            ipAddress,
            browserInfo,
            userAgent,
            tableSchema: 'auth',
            tableName: 'users',
            auditType: AUDIT_TYPES.BUSINESS
        });
    }

    // Метод для логування системних помилок
    static async logError(userId, error, entityType = null, entityId = null, details = null) {
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
            auditType: AUDIT_TYPES.SYSTEM
        });
    }
}

module.exports = AuditService;