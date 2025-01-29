const { pool } = require('../database');

/**
 * Сервіс для логування дій користувачів
 */
const auditLogTypes = {
    AUTH: {
        LOGIN: 'LOGIN',
        LOGOUT: 'LOGOUT',
        LOGIN_FAILED: 'LOGIN_FAILED'
    },
    USER: {
        CREATE: 'USER_CREATE',
        UPDATE: 'USER_UPDATE',
        DELETE: 'USER_DELETE',
        STATUS_CHANGE: 'USER_STATUS_CHANGE',
        PASSWORD_CHANGE: 'USER_PASSWORD_CHANGE'
    },
    ROLE: {
        CREATE: 'ROLE_CREATE',
        UPDATE: 'ROLE_UPDATE',
        DELETE: 'ROLE_DELETE'
    }
};

class AuditService {
    /**
     * Зберігає запис аудиту в базу даних
     */
    static async log({ userId, actionType, entityType, entityId, oldValues = null, newValues = null, ipAddress }) {
        try {
            const { rows } = await pool.query(
                `INSERT INTO audit_logs 
                (user_id, action_type, entity_type, entity_id, old_values, new_values, ip_address)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id`,
                [
                    userId,
                    actionType,
                    entityType,
                    entityId,
                    oldValues ? JSON.stringify(oldValues) : null,
                    newValues ? JSON.stringify(newValues) : null,
                    ipAddress
                ]
            );

            console.log(`Audit log created: ${actionType} by user ${userId}`);
            return rows[0];
        } catch (error) {
            console.error('Error creating audit log:', error);
            // Не кидаємо помилку далі, щоб не переривати основний процес
            return null;
        }
    }

    /**
     * Логує спробу входу (успішну чи ні)
     */
    static async logAuth(success, userId, email, ipAddress) {
        return this.log({
            userId: userId || null,
            actionType: success ? auditLogTypes.AUTH.LOGIN : auditLogTypes.AUTH.LOGIN_FAILED,
            entityType: 'USER',
            entityId: userId || null,
            newValues: { email },
            ipAddress
        });
    }

    /**
     * Логує вихід з системи
     */
    static async logLogout(userId, ipAddress) {
        return this.log({
            userId,
            actionType: auditLogTypes.AUTH.LOGOUT,
            entityType: 'USER',
            entityId: userId,
            ipAddress
        });
    }
}

module.exports = {
    AuditService,
    auditLogTypes
};