const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get products list with filtering and pagination
router.get('/', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'sku',
            descending = false,
            search = '',
            manufacturer = '',
            supplier = '',
            status = '',
            dateFrom = '',
            dateTo = '',
            isOwn = ''
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
                p.sku ILIKE $${paramIndex} OR
                m.name ILIKE $${paramIndex} OR
                s.name ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (manufacturer) {
            conditions.push(`man.id = $${paramIndex}`);
            params.push(manufacturer);
            paramIndex++;
        }

        if (supplier) {
            conditions.push(`s.id = $${paramIndex}`);
            params.push(supplier);
            paramIndex++;
        }

        if (status) {
            conditions.push(`p.current_status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        if (dateFrom) {
            conditions.push(`p.purchase_date >= $${paramIndex}::date`);
            params.push(dateFrom);
            paramIndex++;
        }

        if (dateTo) {
            conditions.push(`p.purchase_date <= $${paramIndex}::date`);
            params.push(dateTo);
            paramIndex++;
        }

        if (isOwn !== '') {
            conditions.push(`p.is_own = $${paramIndex}`);
            params.push(isOwn === 'true');
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        let productsQuery = `
            SELECT 
                p.id,
                p.sku,
                p.is_own,
                p.purchase_date,
                p.supplier_warranty_end,
                p.warranty_end,
                p.sale_date,
                p.current_status,
                p.current_object_id,
                p.is_active,
                m.name as model_name,
                m.description as model_description,
                man.name as manufacturer_name,
                s.name as supplier_name,
                p.created_at,
                p.updated_at,
                COALESCE(st.quantity, 0) as stock_quantity
            FROM products.products p
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            JOIN products.suppliers s ON p.supplier_id = s.id
            LEFT JOIN warehouses.stock st ON p.id = st.product_id
            ${whereClause}
            GROUP BY p.id, m.name, m.description, man.name, s.name, st.quantity
            ORDER BY p.${sortBy} ${orderDirection}
        `;

        if (perPage) {
            productsQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(perPage, offset);
        }

        const countQuery = `
            SELECT COUNT(DISTINCT p.id)
            FROM products.products p
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            JOIN products.suppliers s ON p.supplier_id = s.id
            ${whereClause}
        `;

        const [countResult, productsResult] = await Promise.all([
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : []),
            pool.query(productsQuery, params)
        ]);

        res.json({
            success: true,
            products: productsResult.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching products'
        });
    }
});

// Get single product
router.get('/:id', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT 
                p.*,
                m.name as model_name,
                m.description as model_description,
                man.name as manufacturer_name,
                s.name as supplier_name,
                s.contact_person as supplier_contact,
                s.phone as supplier_phone,
                s.email as supplier_email,
                COALESCE(st.quantity, 0) as stock_quantity
            FROM products.products p
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            JOIN products.suppliers s ON p.supplier_id = s.id
            LEFT JOIN warehouses.stock st ON p.id = st.product_id
            WHERE p.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        res.json({
            success: true,
            product: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching product'
        });
    }
});

// Create product
router.post('/', authenticate, checkPermission('products.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            sku, 
            model_id, 
            supplier_id,
            is_own = true,
            purchase_date,
            supplier_warranty_end,
            warranty_end,
            sale_date = null,
            current_status = 'in_stock',
            current_object_id = null,
            quantity = 0
        } = req.body;

        await client.query('BEGIN');

        // Check if SKU exists
        const skuCheck = await client.query(
            'SELECT id FROM products.products WHERE sku = $1',
            [sku]
        );

        if (skuCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Product with this SKU already exists'
            });
        }

        // Create product
        const productResult = await client.query(
            `INSERT INTO products.products (
                sku, model_id, supplier_id, is_own, purchase_date,
                supplier_warranty_end, warranty_end, sale_date,
                current_status, current_object_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [
                sku, model_id, supplier_id, is_own, purchase_date,
                supplier_warranty_end, warranty_end, sale_date,
                current_status, current_object_id
            ]
        );

        // If quantity > 0, create stock record
        if (quantity > 0) {
            await client.query(
                `INSERT INTO warehouses.stock (product_id, warehouse_id, quantity)
                 VALUES ($1, $2, $3)`,
                [productResult.rows[0].id, req.body.warehouse_id, quantity]
            );
        }

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.CREATE,
            entityType: ENTITY_TYPES.PRODUCT,
            entityId: productResult.rows[0].id,
            newValues: req.body,
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            product: productResult.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating product'
        });
    } finally {
        client.release();
    }
});

// Update product
router.put('/:id', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const {
            model_id,
            supplier_id,
            is_own,
            purchase_date,
            supplier_warranty_end,
            warranty_end,
            sale_date,
            current_status,
            current_object_id
        } = req.body;

        await client.query('BEGIN');

        // Get old product data
        const oldProduct = await client.query(
            'SELECT * FROM products.products WHERE id = $1',
            [id]
        );

        if (oldProduct.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Update product
        const result = await client.query(
            `UPDATE products.products 
             SET model_id = COALESCE($1, model_id),
                 supplier_id = COALESCE($2, supplier_id),
                 is_own = COALESCE($3, is_own),
                 purchase_date = COALESCE($4, purchase_date),
                 supplier_warranty_end = COALESCE($5, supplier_warranty_end),
                 warranty_end = COALESCE($6, warranty_end),
                 sale_date = COALESCE($7, sale_date),
                 current_status = COALESCE($8, current_status),
                 current_object_id = COALESCE($9, current_object_id),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $10
             RETURNING *`,
            [
                model_id, supplier_id, is_own, purchase_date,
                supplier_warranty_end, warranty_end, sale_date,
                current_status, current_object_id, id
            ]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.UPDATE,
            entityType: ENTITY_TYPES.PRODUCT,
            entityId: id,
            oldValues: oldProduct.rows[0],
            newValues: req.body,
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            product: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating product'
        });
    } finally {
        client.release();
    }
});

// Update product status
router.put('/:id/status', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { status, object_id = null } = req.body;

        await client.query('BEGIN');

        // Get old product data
        const oldProduct = await client.query(
            'SELECT * FROM products.products WHERE id = $1',
            [id]
        );

        if (oldProduct.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Update status
        const result = await client.query(
            `UPDATE products.products 
             SET current_status = $1,
                 current_object_id = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING *`,
            [status, object_id, id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.STATUS_CHANGE,
            entityType: ENTITY_TYPES.PRODUCT,
            entityId: id,
            oldValues: { 
                status: oldProduct.rows[0].current_status,
                object_id: oldProduct.rows[0].current_object_id
            },
            newValues: { status, object_id },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            product: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating product status:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating product status'
        });
    } finally {
        client.release();
    }
});
// Delete product
router.delete('/:id', authenticate, checkPermission('products.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        await client.query('BEGIN');

        // Get product data for audit
        const productData = await client.query(
            'SELECT * FROM products.products WHERE id = $1',
            [id]
        );

        if (productData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Check if product has stock
        const stockCheck = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE product_id = $1 AND quantity > 0',
            [id]
        );

        if (stockCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete product with existing stock'
            });
        }

        // Check if product has movements
        const movementsCheck = await client.query(
            'SELECT id FROM warehouses.stock_movements WHERE product_id = $1 LIMIT 1',
            [id]
        );

        if (movementsCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete product with movement history'
            });
        }

        // Delete stock records first
        await client.query(
            'DELETE FROM warehouses.stock WHERE product_id = $1',
            [id]
        );

        // Delete product
        await client.query(
            'DELETE FROM products.products WHERE id = $1',
            [id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.DELETE,
            entityType: ENTITY_TYPES.PRODUCT,
            entityId: id,
            oldValues: productData.rows[0],
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Product deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting product'
        });
    } finally {
        client.release();
    }
});


module.exports = router;