const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const { checkPermission } = require('../middleware/checkPermission');
const StockService = require('../services/stock.service');
const ExcelJS = require('exceljs');

// Get stock with filtering and pagination
router.get('/', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const result = await StockService.getStock(req.query);
        res.json(result);
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
        const result = await StockService.getStockMovements(req.query);
        res.json(result);
    } catch (error) {
        console.error('Error fetching stock movements:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching stock movements'
        });
    }
});

// Get current location of product
router.get('/current-location/:id', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const result = await StockService.getCurrentLocation(req.params.id);
        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching product location:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching product location'
        });
    }
});

// Transfer stock between warehouses
router.post('/transfer', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate transfer
        const validation = await StockService.validateTransfer(client, req.body);
        if (!validation.isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const movement = await StockService.transferStock(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Stock transferred successfully',
            movement
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

// Adjust stock quantity (increase/decrease)
router.post('/adjust', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate adjustment
        const validation = await StockService.validateAdjustment(client, req.body);
        if (!validation.isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const movement = await StockService.adjustStock(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Stock adjusted successfully',
            movement
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

// Install product
router.post('/install', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate installation
        const validation = await StockService.validateInstallation(client, req.body);
        if (!validation.isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const movement = await StockService.installProduct(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Product installed successfully',
            movement
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error installing product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while installing product'
        });
    } finally {
        client.release();
    }
});

// Uninstall product
router.post('/uninstall', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate uninstallation
        const validation = await StockService.validateUninstallation(client, req.body);
        if (!validation.isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const movement = await StockService.uninstallProduct(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Product uninstalled successfully',
            movement
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error uninstalling product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while uninstalling product'
        });
    } finally {
        client.release();
    }
});

// Send product to repair
router.post('/repair/send', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate repair send
        const validation = await StockService.validateRepairSend(client, req.body);
        if (!validation.isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const movement = await StockService.sendToRepair(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Product sent to repair successfully',
            movement
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error sending product to repair:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while sending product to repair'
        });
    } finally {
        client.release();
    }
});

// Return product from repair
router.post('/repair/return', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate repair return
        const validation = await StockService.validateRepairReturn(client, req.body);
        if (!validation.isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const movement = await StockService.returnFromRepair(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Product returned from repair successfully',
            movement
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error returning product from repair:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while returning product from repair'
        });
    } finally {
        client.release();
    }
});

// Write off product
router.post('/write-off', authenticate, checkPermission('warehouses.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate write off
        const validation = await StockService.validateWriteOff(client, req.body);
        if (!validation.isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const movement = await StockService.writeOffProduct(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Product written off successfully',
            movement
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error writing off product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while writing off product'
        });
    } finally {
        client.release();
    }
});
// Export movements to Excel
router.get('/movements/export', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const {
            search, fromWarehouse, toWarehouse, type, dateFrom, dateTo
        } = req.query;

        // Логуємо початок експорту
        const browserInfo = {
            userAgent: req.headers['user-agent'],
            platform: req.headers['sec-ch-ua-platform'],
            mobile: req.headers['sec-ch-ua-mobile']
        };

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.STOCK.EXPORT,
            entityType: ENTITY_TYPES.STOCK,
            ipAddress: req.ip,
            browserInfo,
            userAgent: req.headers['user-agent'],
            newValues: { filters: req.query },
            tableSchema: 'warehouses',
            tableName: 'stock_movements',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        // Отримуємо дані для експорту
        const result = await StockService.getStockMovements({
            ...req.query,
            perPage: 'All' // Експортуємо всі дані
        });

        // Створюємо новий документ Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Stock Movements');

        // Встановлюємо заголовки
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 20 },
            { header: 'Product', key: 'product', width: 20 },
            { header: 'Type', key: 'type', width: 15 },
            { header: 'Quantity', key: 'quantity', width: 10 },
            { header: 'From Warehouse', key: 'fromWarehouse', width: 20 },
            { header: 'To Warehouse', key: 'toWarehouse', width: 20 },
            { header: 'Created By', key: 'createdBy', width: 20 },
            { header: 'Comment', key: 'comment', width: 40 },
            // Додайте інші потрібні колонки
        ];

        // Додаємо дані
        result.movements.forEach(movement => {
            worksheet.addRow({
                date: new Date(movement.created_at).toLocaleString(),
                product: movement.sku + ' - ' + movement.model_name,
                type: movement.type,
                quantity: movement.quantity,
                fromWarehouse: movement.from_warehouse_name || '-',
                toWarehouse: movement.to_warehouse_name || '-',
                createdBy: movement.created_by_name,
                comment: movement.comment || '-',
                // Додайте інші поля
            });
        });

        // Стилізуємо заголовки
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        // Встановлюємо заголовки відповіді
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=stock-movements-${new Date().toISOString().slice(0,10)}.xlsx`
        );

        // Відправляємо файл
        await workbook.xlsx.write(res);
        res.end();

        // Логуємо успішний експорт
        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.STOCK.EXPORT_SUCCESS,
            entityType: ENTITY_TYPES.STOCK,
            ipAddress: req.ip,
            browserInfo,
            userAgent: req.headers['user-agent'],
            newValues: {
                recordsCount: result.movements.length,
                exportDate: new Date().toISOString()
            },
            tableSchema: 'warehouses',
            tableName: 'stock_movements',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

    } catch (error) {
        console.error('Error exporting stock movements:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while exporting stock movements'
        });
    }
    
});


// Отримання загальних метрик про запаси
router.get('/metrics', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const metrics = await StockService.getStockMetrics();
        
        res.json({
            success: true,
            metrics
        });
    } catch (error) {
        console.error('Error fetching stock metrics:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching stock metrics'
        });
    }
});

// Отримання розподілу запасів по складах
router.get('/by-warehouse', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const warehouses = await StockService.getStockByWarehouse();
        
        res.json({
            success: true,
            warehouses
        });
    } catch (error) {
        console.error('Error fetching stock by warehouse:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching stock by warehouse'
        });
    }
});

// Отримання розподілу запасів за типами товарів
router.get('/by-type', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const types = await StockService.getStockByType();
        
        res.json({
            success: true,
            types
        });
    } catch (error) {
        console.error('Error fetching stock by type:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching stock by type'
        });
    }
});

// Отримання списку товарів з критично малим залишком
router.get('/critical', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const items = await StockService.getCriticalStock(parseInt(limit));
        
        res.json({
            success: true,
            items
        });
    } catch (error) {
        console.error('Error fetching critical stock:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching critical stock'
        });
    }
});

// Отримання товарів з малим залишком (для повної таблиці з пагінацією)
router.get('/low-stock', authenticate, checkPermission('warehouses.read'), async (req, res) => {
    try {
        const { 
            page = 1, 
            perPage = 10,
            sortBy = 'quantity',
            descending = false,
            search = '',
            warehouse = '',
            manufacturer = '',
            model = '',
            maxQuantity = 10 // За замовчуванням показувати товари з кількістю <= 10
        } = req.query;
        
        // Будуємо умови для WHERE
        let conditions = ['s.quantity > 0 AND s.quantity <= $1 AND p.is_active = true AND w.is_active = true'];
        let params = [parseInt(maxQuantity)];
        let paramIndex = 2;
        
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
        
        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        
        // Визначаємо сортування
        const sortMapping = {
            'sku': 'p.sku',
            'model_name': 'm.name',
            'manufacturer_name': 'man.name',
            'warehouse_name': 'w.name',
            'quantity': 's.quantity'
        };
        
        const sortByColumn = sortMapping[sortBy] || 's.quantity';
        const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
        
        // Формуємо SQL запит
        const query = `
            SELECT 
                s.id,
                s.product_id,
                s.warehouse_id,
                s.quantity,
                p.sku,
                w.name as warehouse_name,
                m.name as model_name,
                man.name as manufacturer_name
            FROM warehouses.stock s
            JOIN warehouses.warehouses w ON s.warehouse_id = w.id
            JOIN products.products p ON s.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            ${whereClause}
            ORDER BY ${sortByColumn} ${orderDirection}
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        
        const countQuery = `
            SELECT COUNT(*) 
            FROM warehouses.stock s
            JOIN warehouses.warehouses w ON s.warehouse_id = w.id
            JOIN products.products p ON s.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            ${whereClause}
        `;
        
        // Додаємо параметри для ліміту та офсету
        params.push(parseInt(perPage), (parseInt(page) - 1) * parseInt(perPage));
        
        // Виконуємо запити
        const [itemsResult, totalResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, params.slice(0, paramIndex - 1))
        ]);
        
        res.json({
            success: true,
            items: itemsResult.rows,
            total: parseInt(totalResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching low stock items:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching low stock items'
        });
    }
});

module.exports = router;