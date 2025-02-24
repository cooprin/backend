const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const ProductTypeService = require('../services/product-types.service');


// Get product types list
router.get('/', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const result = await ProductTypeService.getProductTypes(req.query);
        res.json(result);
    } catch (error) {
        console.error('Error fetching product types:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching product types'
        });
    }
});

// Get product type codes
router.get('/codes', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const result = await ProductTypeService.getProductTypeCodes();
        res.json({
            success: true,
            codes: result
        });
    } catch (error) {
        console.error('Error fetching product type codes:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching product type codes'
        });
    }
});

// Get single product type with characteristics
router.get('/:id', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const result = await ProductTypeService.getProductTypeById(req.params.id);
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Product type not found'
            });
        }
        res.json({
            success: true,
            productType: result
        });
    } catch (error) {
        console.error('Error fetching product type:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching product type'
        });
    }
});

// Create product type
router.post('/', authenticate, checkPermission('products.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if code exists
        const codeExists = await ProductTypeService.checkCodeExists(client, req.body.code);
        if (codeExists) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Product type with this code already exists'
            });
        }

        const productType = await ProductTypeService.createProductType(client, {
            ...req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            productType
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating product type:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating product type'
        });
    } finally {
        client.release();
    }
});

// Update product type
router.put('/:id', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const oldProductType = await ProductTypeService.getProductTypeById(req.params.id);
        if (!oldProductType) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product type not found'
            });
        }

        // Check code uniqueness if it's being changed
        if (req.body.code && req.body.code !== oldProductType.code) {
            const codeExists = await ProductTypeService.checkCodeExists(client, req.body.code, req.params.id);
            if (codeExists) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Product type with this code already exists'
                });
            }
        }

        const productType = await ProductTypeService.updateProductType(client, {
            id: req.params.id,
            data: req.body,
            oldProductType,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            productType
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating product type:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating product type'
        });
    } finally {
        client.release();
    }
});

// Delete product type
router.delete('/:id', authenticate, checkPermission('products.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if product type can be deleted
        const result = await ProductTypeService.canDeleteProductType(client, req.params.id);
        if (!result.canDelete) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }
        // Check if type has models
const modelsCheck = await client.query(
    'SELECT id FROM products.models WHERE product_type_id = $1 LIMIT 1',
    [typeId]
);

if (modelsCheck.rows.length > 0) {
    return {
        canDelete: false,
        message: 'Cannot delete product type with existing models',
        productType
    };
}

        await ProductTypeService.deleteProductType(client, {
            id: req.params.id,
            oldProductType: result.productType,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Product type deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting product type:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting product type'
        });
    } finally {
        client.release();
    }
});

// Add characteristic to product type
router.post('/:id/characteristics', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const productType = await ProductTypeService.getProductTypeById(req.params.id);
        if (!productType) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product type not found'
            });
        }

        // Check if characteristic code exists
        const codeExists = await ProductTypeService.checkCharacteristicCodeExists(
            client, 
            req.params.id, 
            req.body.code
        );
        if (codeExists) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Characteristic with this code already exists for this product type'
            });
        }

        const characteristic = await ProductTypeService.addCharacteristic(client, {
            productTypeId: req.params.id,
            data: req.body,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            characteristic
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding characteristic:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while adding characteristic'
        });
    } finally {
        client.release();
    }
});

// Update characteristic
router.put('/:typeId/characteristics/:charId', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const characteristic = await ProductTypeService.getCharacteristicById(req.params.charId);
        if (!characteristic) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Characteristic not found'
            });
        }

        // Check code uniqueness if it's being changed
        if (req.body.code && req.body.code !== characteristic.code) {
            const codeExists = await ProductTypeService.checkCharacteristicCodeExists(
                client, 
                req.params.typeId, 
                req.body.code, 
                req.params.charId
            );
            if (codeExists) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Characteristic with this code already exists for this product type'
                });
            }
        }

        const updatedCharacteristic = await ProductTypeService.updateCharacteristic(client, {
            characteristicId: req.params.charId,
            data: req.body,
            oldCharacteristic: characteristic,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            characteristic: updatedCharacteristic
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating characteristic:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating characteristic'
        });
    } finally {
        client.release();
    }
});

// Delete characteristic
router.delete('/:typeId/characteristics/:charId', authenticate, checkPermission('products.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const characteristic = await ProductTypeService.getCharacteristicById(req.params.charId);
        if (!characteristic) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Characteristic not found'
            });
        }

        // Check if characteristic can be deleted
        const result = await ProductTypeService.canDeleteCharacteristic(client, req.params.charId);
        if (!result.canDelete) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        await ProductTypeService.deleteCharacteristic(client, {
            characteristicId: req.params.charId,
            oldCharacteristic: characteristic,
            userId: req.user.userId,
            ipAddress: req.ip,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Characteristic deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting characteristic:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting characteristic'
        });
    } finally {
        client.release();
    }
});
// Get characteristics for product type
router.get('/:id/characteristics', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const { id } = req.params;
        const characteristics = await ProductTypeService.getTypeCharacteristics(id);
        
        res.json({
            success: true,
            characteristics
        });
    } catch (error) {
        console.error('Error fetching characteristics:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching characteristics'
        });
    }
});


module.exports = router;