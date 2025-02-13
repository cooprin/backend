const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get stock with filtering and pagination
router.get('/', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'created_at',
            descending = true,
            search = '',
            warehouse = '',
            manufacturer = '',
            model = '',
            status = '',
            minQuantity = ''
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
                man.name ILIKE $${paramIndex} OR
                w.name ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (warehouse) {
            conditions.push(`w.id = $${paramIndex}`);
            params.push(warehouse);
            paramIndex++;
        }

        if (manufacturer) {
            conditions.push(`man.id = $${paramIndex}`);
            params.push(manufacturer);
            paramIndex++;
        }

        if (model) {
            conditions.push(`m.id = $${paramIndex}`);
            params.push(model);
            paramIndex++;
        }

        if (status) {
            conditions.push(`p.current_status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        if (minQuantity !== '') {
            conditions.push(`s.quantity >= $${paramIndex}`);
            params.push(parseInt(minQuantity));
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        let stockQuery = `
            SELECT 
                s.id,
                s.warehouse_id,
                w.name as warehouse_name,
                s.product_id,
                p.sku,
                m.name as model_name,
                man.name as manufacturer_name,
                s.quantity,
                s.price,
                p.current_status,
                p.warranty_end,
                s.created_at,
                s.updated_at
            FROM warehouses.stock s
            JOIN warehouses.warehouses w ON s.warehouse_id = w.id
            JOIN products.products p ON s.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            ${whereClause}
            ORDER BY s.${sortBy} ${orderDirection}
        `;

        if (perPage) {
            stockQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(perPage, offset);
        }

        const countQuery = `
            SELECT COUNT(*) 
            FROM warehouses.stock s
            JOIN warehouses.warehouses w ON s.warehouse_id = w.id
            JOIN products.products p ON s.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            ${whereClause}
        `;

        const [countResult, stockResult] = await Promise.all([
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : []),
            pool.query(stockQuery, params)
        ]);

        res.json({
            success: true,
            stock: stockResult.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching stock:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching stock'
        });
    }
});

// Get stock movements with filtering and pagination
router.get('/movements', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'created_at',
            descending = true,
            search = '',
            fromWarehouse = '',
            toWarehouse = '',
            type = '',
            dateFrom = '',
            dateTo = '',
            createdBy = ''
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
                sm.comment ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (fromWarehouse) {
            conditions.push(`sm.from_warehouse_id = $${paramIndex}`);
            params.push(fromWarehouse);
            paramIndex++;
        }

        if (toWarehouse) {
            conditions.push(`sm.to_warehouse_id = $${paramIndex}`);
            params.push(toWarehouse);
            paramIndex++;
        }

        if (type) {
            conditions.push(`sm.type = $${paramIndex}`);
            params.push(type);
            paramIndex++;
        }

        if (dateFrom) {
            conditions.push(`sm.created_at >= $${paramIndex}::timestamp`);
            params.push(dateFrom);
            paramIndex++;
        }

        if (dateTo) {
            conditions.push(`sm.created_at <= $${paramIndex}::timestamp`);
            params.push(dateTo);
            paramIndex++;
        }

        if (createdBy) {
            conditions.push(`sm.created_by = $${paramIndex}`);
            params.push(createdBy);
            paramIndex++;
        }

        if (product_id) {
            conditions.push(`sm.product_id = $${paramIndex}`);
            params.push(product_id);
            paramIndex++;
          }
        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        let movementsQuery = `
            SELECT 
                sm.*,
                p.sku,
                m.name as model_name,
                wf.name as from_warehouse_name,
                wt.name as to_warehouse_name,
                u.email as created_by_email,
                u.first_name || ' ' || u.last_name as created_by_name
            FROM warehouses.stock_movements sm
            JOIN products.products p ON sm.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            LEFT JOIN warehouses.warehouses wf ON sm.from_warehouse_id = wf.id
            LEFT JOIN warehouses.warehouses wt ON sm.to_warehouse_id = wt.id
            JOIN auth.users u ON sm.created_by = u.id
            ${whereClause}
            ORDER BY sm.${sortBy} ${orderDirection}
        `;

        if (perPage) {
            movementsQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(perPage, offset);
        }

        const countQuery = `
            SELECT COUNT(*) 
            FROM warehouses.stock_movements sm
            JOIN products.products p ON sm.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            ${whereClause}
        `;

        const [countResult, movementsResult] = await Promise.all([
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : []),
            pool.query(movementsQuery, params)
        ]);

        res.json({
            success: true,
            movements: movementsResult.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching stock movements:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching stock movements'
        });
    }
});

// Transfer stock between warehouses
router.post('/transfer', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            product_id,
            from_warehouse_id,
            to_warehouse_id,
            quantity,
            comment = null
        } = req.body;

        if (from_warehouse_id === to_warehouse_id) {
            return res.status(400).json({
                success: false,
                message: 'Cannot transfer to the same warehouse'
            });
        }

        await client.query('BEGIN');

        // Check source stock
        const sourceStock = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [from_warehouse_id, product_id]
        );

        if (sourceStock.rows.length === 0 || sourceStock.rows[0].quantity < quantity) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Insufficient stock in source warehouse'
            });
        }

        // Update source stock
        await client.query(
            `UPDATE warehouses.stock 
             SET quantity = quantity - $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE warehouse_id = $2 AND product_id = $3`,
            [quantity, from_warehouse_id, product_id]
        );

        // Update or create destination stock
        await client.query(
            `INSERT INTO warehouses.stock (warehouse_id, product_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, product_id) 
             DO UPDATE SET 
                quantity = warehouses.stock.quantity + EXCLUDED.quantity,
                updated_at = CURRENT_TIMESTAMP`,
            [to_warehouse_id, product_id, quantity]
        );

        // Create movement record
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id, from_warehouse_id, to_warehouse_id, 
                quantity, type, comment, created_by
            )
            VALUES ($1, $2, $3, $4, 'transfer', $5, $6)
            RETURNING *`,
            [product_id, from_warehouse_id, to_warehouse_id, quantity, comment, req.user.userId]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.STOCK.TRANSFER,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                from_warehouse_id,
                to_warehouse_id,
                quantity,
                comment
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Stock transferred successfully',
            movement: movement.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error transferring stock:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while transferring stock'
        });
    } finally {
        client.release();
    }
});

// Adjust stock quantity
router.post('/adjust', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            product_id,
            warehouse_id,
            quantity,
            type,
            comment = null
        } = req.body;

        await client.query('BEGIN');

        // Get current stock
        const currentStock = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [warehouse_id, product_id]
        );

        const currentQuantity = currentStock.rows.length > 0 ? currentStock.rows[0].quantity : 0;
        const newQuantity = type === 'increase' ? currentQuantity + quantity : currentQuantity - quantity;

        if (newQuantity < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot reduce stock below zero'
            });
        }

        // Update stock
        await client.query(
            `INSERT INTO warehouses.stock (warehouse_id, product_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, product_id) 
             DO UPDATE SET 
                quantity = EXCLUDED.quantity,
                updated_at = CURRENT_TIMESTAMP`,
            [warehouse_id, product_id, newQuantity]
        );

        // Create movement record
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id, 
                from_warehouse_id,
                to_warehouse_id,
                quantity, 
                type, 
                comment, 
                created_by
            )
            VALUES (
                $1, 
                $2,
                $3,
                $4, 
                $5, 
                $6, 
                $7
            )
            RETURNING *`,
            [
                product_id, 
                type === 'decrease' ? warehouse_id : null,
                type === 'increase' ? warehouse_id : null,
                quantity,
                type === 'increase' ? 'stock_in' : 'stock_out',
                comment,
                req.user.userId
            ]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: type === 'increase' ? AUDIT_LOG_TYPES.STOCK.INCREASE : AUDIT_LOG_TYPES.STOCK.DECREASE,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            oldValues: { quantity: currentQuantity },
            newValues: { 
                quantity: newQuantity,
                type,
                comment
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Stock adjusted successfully',
            movement: movement.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adjusting stock:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while adjusting stock'
        });
    } finally {
        client.release();
    }
});
// Додаємо новий ендпоінт для отримання поточного розташування продукту
router.get('/current-location/:id', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
  
      const result = await client.query(`
        SELECT 
          w.id as warehouse_id,
          w.name as warehouse_name,
          s.quantity,
          s.price
        FROM warehouses.stock s
        JOIN warehouses.warehouses w ON s.warehouse_id = w.id
        WHERE s.product_id = $1 AND s.quantity > 0
        LIMIT 1
      `, [id]);
  
      res.json({
        success: true,
        ...result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching product location:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching product location'
      });
    } finally {
      client.release();
    }
  });

module.exports = router;