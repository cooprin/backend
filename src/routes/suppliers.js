const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get suppliers list with filtering and pagination
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
            conditions.push(`(
                name ILIKE $${paramIndex} OR 
                description ILIKE $${paramIndex} OR 
                contact_person ILIKE $${paramIndex} OR 
                phone ILIKE $${paramIndex} OR 
                email ILIKE $${paramIndex} OR 
                address ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (isActive !== '') {
            conditions.push(`is_active = $${paramIndex}`);
            params.push(isActive === 'true');
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        let suppliersQuery = `
            SELECT 
                s.*,
                COUNT(DISTINCT p.id) as products_count,
                COUNT(DISTINCT CASE WHEN p.warranty_end > CURRENT_DATE THEN p.id END) as warranty_active_count
            FROM products.suppliers s
            LEFT JOIN products.products p ON s.id = p.supplier_id
            ${whereClause}
            GROUP BY s.id
            ORDER BY s.${sortBy} ${orderDirection}
        `;

        if (perPage) {
            suppliersQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(perPage, offset);
        }

        const countQuery = `
            SELECT COUNT(*) 
            FROM products.suppliers
            ${whereClause}
        `;

        const [countResult, suppliersResult] = await Promise.all([
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : []),
            pool.query(suppliersQuery, params)
        ]);

        res.json({
            success: true,
            suppliers: suppliersResult.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching suppliers:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching suppliers'
        });
    }
});

// Get single supplier
router.get('/:id', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT 
                s.*,
                COUNT(DISTINCT p.id) as products_count,
                COUNT(DISTINCT CASE WHEN p.warranty_end > CURRENT_DATE THEN p.id END) as warranty_active_count,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', p.id,
                        'sku', p.sku,
                        'warranty_end', p.warranty_end,
                        'current_status', p.current_status
                    )
                ) FILTER (WHERE p.id IS NOT NULL) as products
            FROM products.suppliers s
            LEFT JOIN products.products p ON s.id = p.supplier_id
            WHERE s.id = $1
            GROUP BY s.id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Supplier not found'
            });
        }

        res.json({
            success: true,
            supplier: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching supplier:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching supplier'
        });
    }
});

// Create supplier
router.post('/', authenticate, checkPermission('products.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            name, 
            description, 
            contact_person,
            phone,
            email,
            address
        } = req.body;

        await client.query('BEGIN');

        // Check if name exists
        const nameCheck = await client.query(
            'SELECT id FROM products.suppliers WHERE name = $1',
            [name]
        );

        if (nameCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Supplier with this name already exists'
            });
        }

        // Create supplier
        const result = await client.query(
            `INSERT INTO products.suppliers (
                name, description, contact_person, phone, email, address
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [name, description, contact_person, phone, email, address]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.SUPPLIER_CREATE,
            entityType: ENTITY_TYPES.SUPPLIER,
            entityId: result.rows[0].id,
            newValues: { 
                name, description, contact_person, phone, email, address 
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            supplier: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating supplier:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating supplier'
        });
    } finally {
        client.release();
    }
});

// Update supplier
router.put('/:id', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { 
            name, 
            description, 
            contact_person,
            phone,
            email,
            address,
            is_active
        } = req.body;

        await client.query('BEGIN');

        // Get old supplier data
        const oldData = await client.query(
            'SELECT * FROM products.suppliers WHERE id = $1',
            [id]
        );

        if (oldData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Supplier not found'
            });
        }

        // Check name uniqueness if it's being changed
        if (name && name !== oldData.rows[0].name) {
            const nameCheck = await client.query(
                'SELECT id FROM products.suppliers WHERE name = $1 AND id != $2',
                [name, id]
            );

            if (nameCheck.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Supplier with this name already exists'
                });
            }
        }

        // Update supplier
        const result = await client.query(
            `UPDATE products.suppliers 
             SET name = COALESCE($1, name),
                 description = COALESCE($2, description),
                 contact_person = COALESCE($3, contact_person),
                 phone = COALESCE($4, phone),
                 email = COALESCE($5, email),
                 address = COALESCE($6, address),
                 is_active = COALESCE($7, is_active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING *`,
            [name, description, contact_person, phone, email, address, is_active, id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.SUPPLIER_UPDATE,
            entityType: ENTITY_TYPES.SUPPLIER,
            entityId: id,
            oldValues: oldData.rows[0],
            newValues: { 
                name, description, contact_person, phone, email, address, is_active 
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            supplier: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating supplier:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating supplier'
        });
    } finally {
        client.release();
    }
});

// Delete supplier
router.delete('/:id', authenticate, checkPermission('products.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        await client.query('BEGIN');

        // Get supplier data for audit
        const supplierData = await client.query(
            'SELECT * FROM products.suppliers WHERE id = $1',
            [id]
        );

        if (supplierData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Supplier not found'
            });
        }

        // Check if supplier has products
        const productsCheck = await client.query(
            'SELECT id FROM products.products WHERE supplier_id = $1 LIMIT 1',
            [id]
        );

        if (productsCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete supplier with existing products'
            });
        }

        // Delete supplier
        await client.query(
            'DELETE FROM products.suppliers WHERE id = $1',
            [id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.SUPPLIER_DELETE,
            entityType: ENTITY_TYPES.SUPPLIER,
            entityId: id,
            oldValues: supplierData.rows[0],
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Supplier deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting supplier:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting supplier'
        });
    } finally {
        client.release();
    }
});

module.exports = router;