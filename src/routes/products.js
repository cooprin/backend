const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const { validateProductCharacteristics } = require('../utils/characteristicsUtils');
const ProductService = require('../services/products.service');
const ExcelJS = require('exceljs');

// Get products list with filtering and pagination
router.get('/', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const result = await ProductService.getProducts(req.query);
        res.json(result);
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
        const result = await ProductService.getProductById(req.params.id);
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        res.json({
            success: true,
            product: result
        });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching product'
        });
    }
});

// Get product type characteristics
router.get('/type-characteristics/:typeId', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const result = await ProductService.getTypeCharacteristics(req.params.typeId);
        res.json({
            success: true,
            characteristics: result
        });
    } catch (error) {
        console.error('Error fetching type characteristics:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching type characteristics'
        });
    }
});

// Create product
router.post('/', authenticate, checkPermission('products.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if SKU exists
        const skuExists = await ProductService.checkSkuExists(client, req.body.sku);
        if (skuExists) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Product with this SKU already exists'
            });
        }


        // Validate characteristics
        const { isValid, errors } = await validateProductCharacteristics(
            client, 
            req.body.product_type_id, 
            req.body.characteristics || {}
        );

        if (!isValid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Invalid characteristics',
                errors
            });
        }

        // Create product
        const product = await ProductService.createProduct(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            product
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
        await client.query('BEGIN');

        // Check if product exists
        const oldProduct = await ProductService.getProductById(req.params.id);
        if (!oldProduct) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Validate characteristics if they are being updated
        if (req.body.characteristics) {
            const { isValid, errors } = await validateProductCharacteristics(
                client, 
                req.body.product_type_id || oldProduct.product_type_id, 
                req.body.characteristics
            );
            
            if (!isValid) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Invalid characteristics',
                    errors
                });
            }
        }

        // Update product
        const product = await ProductService.updateProduct(client, {
            id: req.params.id,
            data: req.body,
            oldProduct,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            product
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
        await client.query('BEGIN');

        // Check if product exists
        const oldProduct = await ProductService.getProductById(req.params.id);
        if (!oldProduct) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Update status
        const product = await ProductService.updateProductStatus(client, {
            id: req.params.id,
            status: req.body.status,
            objectId: req.body.object_id,
            oldProduct,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            product
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
        await client.query('BEGIN');

        // Check if product exists and can be deleted
        const result = await ProductService.canDeleteProduct(client, req.params.id);
        if (!result.canDelete) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        // Delete product
        await ProductService.deleteProduct(client, {
            id: req.params.id,
            oldProduct: result.product,
            userId: req.user.userId,
            ipAddress: req.ip,
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

// Export to Excel
router.get('/export', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        // Отримуємо параметри фільтрації
        const { search, manufacturer_id, model_id, current_status, is_own } = req.query;

        // Логуємо початок експорту
        const browserInfo = {
            userAgent: req.headers['user-agent'],
            platform: req.headers['sec-ch-ua-platform'],
            mobile: req.headers['sec-ch-ua-mobile']
        };

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.EXPORT,
            entityType: ENTITY_TYPES.PRODUCT,
            ipAddress: req.ip,
            browserInfo,
            userAgent: req.headers['user-agent'],
            newValues: { filters: req.query },
            tableSchema: 'products',
            tableName: 'products',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        // Отримуємо дані для експорту
        const result = await ProductService.getProducts({
            ...req.query,
            perPage: 'All' // Експортуємо всі дані
        });

        // Створюємо новий документ Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Products');

        // Встановлюємо заголовки
        worksheet.columns = [
            { header: 'SKU', key: 'sku', width: 20 },
            { header: 'Model', key: 'model', width: 30 },
            { header: 'Manufacturer', key: 'manufacturer', width: 20 },
            { header: 'Status', key: 'status', width: 15 },
            { header: 'Is Own', key: 'isOwn', width: 10 },
            // Додайте інші потрібні колонки
        ];

        // Додаємо дані
        result.products.forEach(product => {
            worksheet.addRow({
                sku: product.sku,
                model: product.model_name,
                manufacturer: product.manufacturer_name,
                status: product.current_status,
                isOwn: product.is_own ? 'Yes' : 'No',
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
            `attachment; filename=products-${new Date().toISOString().slice(0,10)}.xlsx`
        );

        // Відправляємо файл
        await workbook.xlsx.write(res);
        res.end();

        // Логуємо успішний експорт
        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.EXPORT_SUCCESS,
            entityType: ENTITY_TYPES.PRODUCT,
            ipAddress: req.ip,
            browserInfo,
            userAgent: req.headers['user-agent'],
            newValues: {
                recordsCount: result.products.length,
                exportDate: new Date().toISOString()
            },
            tableSchema: 'products',
            tableName: 'products',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

    } catch (error) {
        console.error('Error exporting products:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while exporting products'
        });
    }
});

module.exports = router;