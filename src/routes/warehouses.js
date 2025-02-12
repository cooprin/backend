const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get warehouses list with filtering and pagination
router.get('/', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            responsiblePerson = '',
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
            conditions.push(`(
                w.name ILIKE $${paramIndex} OR 
                w.description ILIKE $${paramIndex} OR 
                w.address ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (responsiblePerson) {
            conditions.push(`w.responsible_person_id = $${paramIndex}`);
            params.push(responsiblePerson);
            paramIndex++;
        }

        if (isActive !== '') {
            conditions.push(`w.is_active = $${paramIndex}`);
            params.push(isActive === 'true');
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        let warehousesQuery = `
            SELECT 
                w.*,
                u.email as responsible_person_email,
                u.first_name || ' ' || u.last_name as responsible_person_name,
                COUNT(DISTINCT s.product_id) as products_count,
                COALESCE(SUM(s.quantity), 0) as total_items
            FROM warehouses.warehouses w
            LEFT JOIN auth.users u ON w.responsible_person_id = u.id
            LEFT JOIN warehouses.stock s ON w.id = s.warehouse_id
            ${whereClause}
            GROUP BY w.id, u.email, u.first_name, u.last_name
            ORDER BY w.${sortBy} ${orderDirection}
        `;

        if (perPage) {
            warehousesQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(perPage, offset);
        }

        const countQuery = `
            SELECT COUNT(*) 
            FROM warehouses.warehouses w
            ${whereClause}
        `;

        const [countResult, warehousesResult] = await Promise.all([
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : []),
            pool.query(warehousesQuery, params)
        ]);

        res.json({
            success: true,
            warehouses: warehousesResult.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching warehouses:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching warehouses'
        });
    }
});

// Get single warehouse with stock
router.get('/:id', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT 
                w.*,
                u.email as responsible_person_email,
                u.first_name || ' ' || u.last_name as responsible_person_name,
                COUNT(DISTINCT s.product_id) as products_count,
                COALESCE(SUM(s.quantity), 0) as total_items,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', p.id,
                        'sku', p.sku,
                        'model_name', m.name,
                        'manufacturer_name', man.name,
                        'quantity', s.quantity,
                        'current_status', p.current_status
                    )
                ) FILTER (WHERE p.id IS NOT NULL) as stock
            FROM warehouses.warehouses w
            LEFT JOIN auth.users u ON w.responsible_person_id = u.id
            LEFT JOIN warehouses.stock s ON w.id = s.warehouse_id
            LEFT JOIN products.products p ON s.product_id = p.id
            LEFT JOIN products.models m ON p.model_id = m.id
            LEFT JOIN products.manufacturers man ON m.manufacturer_id = man.id
            WHERE w.id = $1
            GROUP BY w.id, u.email, u.first_name, u.last_name
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Warehouse not found'
            });
        }

        // Get recent movements
        const movements = await pool.query(`
            SELECT 
                sm.*,
                p.sku,
                m.name as model_name,
                u.email as created_by_email,
                u.first_name || ' ' || u.last_name as created_by_name
            FROM warehouses.stock_movements sm
            JOIN products.products p ON sm.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            JOIN auth.users u ON sm.created_by = u.id
            WHERE sm.from_warehouse_id = $1 OR sm.to_warehouse_id = $1
            ORDER BY sm.created_at DESC
            LIMIT 10
        `, [id]);

        const warehouse = result.rows[0];
        warehouse.recent_movements = movements.rows;

        res.json({
            success: true,
            warehouse
        });
    } catch (error) {
        console.error('Error fetching warehouse:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching warehouse'
        });
    }
});

// Create warehouse
router.post('/', authenticate, checkPermission('warehouses.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            name, 
            description, 
            address,
            responsible_person_id
        } = req.body;

        await client.query('BEGIN');

        // Check if name exists
        const nameCheck = await client.query(
            'SELECT id FROM warehouses.warehouses WHERE name = $1',
            [name]
        );

        if (nameCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Warehouse with this name already exists'
            });
        }

        // Check if responsible person exists and is active
        const userCheck = await client.query(
            'SELECT id FROM auth.users WHERE id = $1 AND is_active = true',
            [responsible_person_id]
        );

        if (userCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Responsible person not found or inactive'
            });
        }

        // Create warehouse
        const result = await client.query(
            `INSERT INTO warehouses.warehouses (name, description, address, responsible_person_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [name, description, address, responsible_person_id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.WAREHOUSE.CREATE,
            entityType: ENTITY_TYPES.WAREHOUSE,
            entityId: result.rows[0].id,
            newValues: { 
                name, description, address, responsible_person_id
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            warehouse: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating warehouse:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating warehouse'
        });
    } finally {
        client.release();
    }
});

// Update warehouse
router.put('/:id', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { 
            name, 
            description, 
            address,
            responsible_person_id,
            is_active
        } = req.body;

        await client.query('BEGIN');

        // Get old warehouse data
        const oldData = await client.query(
            'SELECT * FROM warehouses.warehouses WHERE id = $1',
            [id]
        );

        if (oldData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Warehouse not found'
            });
        }

        // Check name uniqueness if it's being changed
        if (name && name !== oldData.rows[0].name) {
            const nameCheck = await client.query(
                'SELECT id FROM warehouses.warehouses WHERE name = $1 AND id != $2',
                [name, id]
            );

            if (nameCheck.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Warehouse with this name already exists'
                });
            }
        }

        // Check responsible person if it's being changed
        if (responsible_person_id && responsible_person_id !== oldData.rows[0].responsible_person_id) {
            const userCheck = await client.query(
                'SELECT id FROM auth.users WHERE id = $1 AND is_active = true',
                [responsible_person_id]
            );

            if (userCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Responsible person not found or inactive'
                });
            }
        }

        // Update warehouse
        const result = await client.query(
            `UPDATE warehouses.warehouses 
             SET name = COALESCE($1, name),
                 description = COALESCE($2, description),
                 address = COALESCE($3, address),
                 responsible_person_id = COALESCE($4, responsible_person_id),
                 is_active = COALESCE($5, is_active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $6
             RETURNING *`,
            [name, description, address, responsible_person_id, is_active, id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.WAREHOUSE.UPDATE,
            entityType: ENTITY_TYPES.WAREHOUSE,
            entityId: id,
            oldValues: oldData.rows[0],
            newValues: { 
                name, description, address, responsible_person_id, is_active
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            warehouse: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating warehouse:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating warehouse'
        });
    } finally {
        client.release();
    }
});

// Delete warehouse
router.delete('/:id', authenticate, checkPermission('warehouses.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        await client.query('BEGIN');

        // Get warehouse data for audit
        const warehouseData = await client.query(
            'SELECT * FROM warehouses.warehouses WHERE id = $1',
            [id]
        );

        if (warehouseData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Warehouse not found'
            });
        }

        // Check if warehouse has stock
        const stockCheck = await client.query(
            'SELECT product_id FROM warehouses.stock WHERE warehouse_id = $1 AND quantity > 0 LIMIT 1',
            [id]
        );

        if (stockCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete warehouse with existing stock'
            });
        }

        // Check if warehouse has movements
        const movementsCheck = await client.query(
            'SELECT id FROM warehouses.stock_movements WHERE from_warehouse_id = $1 OR to_warehouse_id = $1 LIMIT 1',
            [id]
        );

        if (movementsCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete warehouse with movement history'
            });
        }

        // Delete warehouse
        await client.query(
            'DELETE FROM warehouses.warehouses WHERE id = $1',
            [id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.WAREHOUSE.DELETE,
            entityType: ENTITY_TYPES.WAREHOUSE,
            entityId: id,
            oldValues: warehouseData.rows[0],
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Warehouse deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting warehouse:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting warehouse'
        });
    } finally {
        client.release();
    }
});

module.exports = router;