const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { checkPermission, checkMultiplePermissions } = require('../middleware/checkPermission');
const { pool } = require('../database');

// Get audit logs
router.get('/', authenticate, checkPermission('audit.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'created_at',
            descending = true,
            actionType,
            entityType,
            dateFrom,
            dateTo,
            search 
        } = req.query;

        // Handle perPage=All case
        if (perPage === 'All') {
            perPage = null;
        } else {
            perPage = parseInt(perPage);
            page = parseInt(page);
        }

        const offset = perPage ? (page - 1) * perPage : 0;
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';

        // Validate sortBy to prevent SQL injection
        const allowedSortColumns = ['created_at', 'action_type', 'entity_type', 'user_email'];
        if (!allowedSortColumns.includes(sortBy)) {
            sortBy = 'created_at';
        }

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                COALESCE(u.email, '') ILIKE $${paramIndex} OR 
                COALESCE(al.action_type, '') ILIKE $${paramIndex} OR 
                COALESCE(al.entity_type, '') ILIKE $${paramIndex}
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

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        const countQuery = `
            SELECT COUNT(*)
            FROM audit_logs al
            LEFT JOIN users u ON al.user_id = u.id
            ${whereClause}
        `;

        let logsQuery = `
            SELECT 
                al.id,
                al.user_id,
                COALESCE(al.action_type, '') as action_type,
                COALESCE(al.entity_type, '') as entity_type,
                al.entity_id,
                al.old_values,
                al.new_values,
                al.ip_address,
                al.created_at,
                COALESCE(u.email, 'System') as user_email
            FROM audit_logs al
            LEFT JOIN users u ON al.user_id = u.id
            ${whereClause}
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
            created_at: log.created_at.toISOString(),
            old_values: log.old_values || {},
            new_values: log.new_values || {}
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

// Get unique action and entity types
router.get('/types', authenticate, checkPermission('audit.read'), async (req, res) => {
    try {
        const actionTypesQuery = `
            SELECT DISTINCT action_type 
            FROM audit_logs 
            WHERE action_type IS NOT NULL
            AND action_type != ''
            ORDER BY action_type
        `;

        const entityTypesQuery = `
            SELECT DISTINCT entity_type 
            FROM audit_logs 
            WHERE entity_type IS NOT NULL
            AND entity_type != ''
            ORDER BY entity_type
        `;

        const [actionTypes, entityTypes] = await Promise.all([
            pool.query(actionTypesQuery),
            pool.query(entityTypesQuery)
        ]);

        res.json({
            success: true,
            actionTypes: actionTypes.rows.map(row => row.action_type).filter(Boolean),
            entityTypes: entityTypes.rows.map(row => row.entity_type).filter(Boolean)
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