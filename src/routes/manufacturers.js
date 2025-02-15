const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get manufacturers list with filtering and pagination
router.get('/', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            isActive = ''
        } = req.query;

        if (perPage === 'All') {
            perPage = null;
        } else {
            perPage = parseInt(perPage);
            page = parseInt(page);
        }
        
        const offset = perPage ? (page - 1) * perPage : 0;
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(m.name ILIKE $${paramIndex} OR m.description ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (isActive !== '') {
            conditions.push(`m.is_active = $${paramIndex}`);
            params.push(isActive === 'true');
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        const query = `
            WITH manufacturer_stats AS (
                SELECT 
                    manufacturer_id,
                    COUNT(DISTINCT id) as models_count
                FROM products.models
                GROUP BY manufacturer_id
            ),
            product_stats AS (
                SELECT 
                    m.manufacturer_id,
                    COUNT(DISTINCT p.id) as products_count
                FROM products.models m
                LEFT JOIN products.products p ON m.id = p.model_id
                GROUP BY m.manufacturer_id
            )
            SELECT 
                m.*,
                COALESCE(ms.models_count, 0) as models_count,
                COALESCE(ps.products_count, 0) as products_count,
                COUNT(*) OVER() as total_count
            FROM products.manufacturers m
            LEFT JOIN manufacturer_stats ms ON m.id = ms.manufacturer_id
            LEFT JOIN product_stats ps ON m.id = ps.manufacturer_id
            ${whereClause}
            ORDER BY m.${sortBy} ${orderDirection}
            ${perPage ? `LIMIT $${paramIndex} OFFSET $${paramIndex + 1}` : ''}
        `;

        if (perPage) {
            params.push(perPage, offset);
        }

        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            manufacturers: result.rows,
            total: result.rows.length > 0 ? result.rows[0].total_count : 0
        });
    } catch (error) {
        console.error('Error fetching manufacturers:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching manufacturers',
            error: error.message, 
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Get single manufacturer
router.get('/:id', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT 
                m.*,
                COUNT(DISTINCT md.id) as models_count,
                COUNT(DISTINCT p.id) as products_count
            FROM products.manufacturers m
            LEFT JOIN products.models md ON m.id = md.manufacturer_id
            LEFT JOIN products.products p ON md.id = p.model_id
            WHERE m.id = $1
            GROUP BY m.id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Manufacturer not found'
            });
        }

        res.json({
            success: true,
            manufacturer: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching manufacturer:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching manufacturer'
        });
    }
});

// Create manufacturer
router.post('/', authenticate, checkPermission('products.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { name, description } = req.body;

        await client.query('BEGIN');

        // Check if name exists
        const nameCheck = await client.query(
            'SELECT id FROM products.manufacturers WHERE name = $1',
            [name]
        );

        if (nameCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Manufacturer with this name already exists'
            });
        }

        // Create manufacturer
        const result = await client.query(
            `INSERT INTO products.manufacturers (name, description)
             VALUES ($1, $2)
             RETURNING *`,
            [name, description]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.MANUFACTURER_CREATE,
            entityType: ENTITY_TYPES.MANUFACTURER,
            entityId: result.rows[0].id,
            newValues: { name, description },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            manufacturer: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating manufacturer:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating manufacturer'
        });
    } finally {
        client.release();
    }
});

// Update manufacturer
router.put('/:id', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { name, description, is_active } = req.body;

        await client.query('BEGIN');

        // Get old manufacturer data
        const oldData = await client.query(
            'SELECT * FROM products.manufacturers WHERE id = $1',
            [id]
        );

        if (oldData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Manufacturer not found'
            });
        }

        // Check name uniqueness if it's being changed
        if (name !== oldData.rows[0].name) {
            const nameCheck = await client.query(
                'SELECT id FROM products.manufacturers WHERE name = $1 AND id != $2',
                [name, id]
            );

            if (nameCheck.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Manufacturer with this name already exists'
                });
            }
        }

        // Update manufacturer
        const result = await client.query(
            `UPDATE products.manufacturers 
             SET name = COALESCE($1, name),
                 description = COALESCE($2, description),
                 is_active = COALESCE($3, is_active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [name, description, is_active, id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.MANUFACTURER_UPDATE,
            entityType: ENTITY_TYPES.MANUFACTURER,
            entityId: id,
            oldValues: oldData.rows[0],
            newValues: { name, description, is_active },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            manufacturer: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating manufacturer:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating manufacturer'
        });
    } finally {
        client.release();
    }
});

// Delete manufacturer
router.delete('/:id', authenticate, checkPermission('products.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        await client.query('BEGIN');

        // Get manufacturer data for audit
        const manufacturerData = await client.query(
            'SELECT * FROM products.manufacturers WHERE id = $1',
            [id]
        );

        if (manufacturerData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Manufacturer not found'
            });
        }

        // Check if manufacturer has models
        const modelsCheck = await client.query(
            'SELECT id FROM products.models WHERE manufacturer_id = $1 LIMIT 1',
            [id]
        );

        if (modelsCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete manufacturer with existing models'
            });
        }

        // Delete manufacturer
        await client.query(
            'DELETE FROM products.manufacturers WHERE id = $1',
            [id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.MANUFACTURER_DELETE,
            entityType: ENTITY_TYPES.MANUFACTURER,
            entityId: id,
            oldValues: manufacturerData.rows[0],
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Manufacturer deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting manufacturer:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting manufacturer'
        });
    } finally {
        client.release();
    }
});

module.exports = router;