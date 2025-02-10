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
        auditType = AUDIT_TYPES.BUSINESS
    }) { try {
            const { rows } = await pool.query(
                `INSERT INTO audit.audit_logs
                 (user_id, action_type, entity_type, entity_id, old_values, new_values, ip_address, audit_type)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id`,
                [
                    userId,
                    actionType,
                    entityType,
                    entityId,
                    oldValues ? JSON.stringify(oldValues) : null,
                    newValues ? JSON.stringify(newValues) : null,
                    ipAddress,
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

    static async logAuth(success, userId, email, ipAddress) {
        return this.log({
            userId: userId || null,
            actionType: success ? AUDIT_LOG_TYPES.AUTH.LOGIN : AUDIT_LOG_TYPES.AUTH.LOGIN_FAILED,
            entityType: ENTITY_TYPES.USER,
            entityId: userId || null,
            newValues: { email },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS
        });
    }

    static async logLogout(userId, ipAddress) {
        return this.log({
            userId,
            actionType: AUDIT_LOG_TYPES.AUTH.LOGOUT,
            entityType: ENTITY_TYPES.USER,
            entityId: userId,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS
        });
    }
}

module.exports = AuditService;