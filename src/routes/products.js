const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const { validateProductCharacteristics } = require('../utils/characteristicsUtils');
const ProductService = require('../services/products.service');

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
        const modelCheck = await client.query(
            'SELECT product_type_id FROM products.models WHERE id = $1',
            [req.body.model_id]
        );
        
        if (modelCheck.rows[0].product_type_id !== req.body.product_type_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Product type must match model product type'
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

module.exports = router;