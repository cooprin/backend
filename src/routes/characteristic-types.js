const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Get characteristic types list
// Get characteristic types list
router.get('/', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                value,
                label,
                description,
                validation
            FROM products.characteristic_types
            ORDER BY label
        `);

        res.json({
            success: true,
            types: result.rows
        });
    } catch (error) {
        console.error('Error fetching characteristic types:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching characteristic types'
        });
    }
});

// Add characteristic to product type
router.post('/:productTypeId/characteristics', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { productTypeId } = req.params;
        const {
            name,
            code,
            type,
            is_required = false,
            default_value = null,
            validation_rules = null,
            options = null,
            ordering = 0
        } = req.body;

        await client.query('BEGIN');

        // Verify product type exists
        const productTypeCheck = await client.query(
            'SELECT id FROM products.product_types WHERE id = $1',
            [productTypeId]
        );

        if (productTypeCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product type not found'
            });
        }

        // Verify characteristic type exists
        const typeCheck = await client.query(
            'SELECT value FROM products.characteristic_types WHERE value = $1',
            [type]
        );

        if (typeCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Invalid characteristic type'
            });
        }

        // Check code uniqueness for this product type
        const codeCheck = await client.query(
            'SELECT id FROM products.product_type_characteristics WHERE product_type_id = $1 AND code = $2',
            [productTypeId, code]
        );

        if (codeCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Characteristic with this code already exists for this product type'
            });
        }

        // Create characteristic
        const result = await client.query(
            `INSERT INTO products.product_type_characteristics 
            (product_type_id, name, code, type, is_required, default_value, validation_rules, options, ordering)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [productTypeId, name, code, type, is_required, default_value, validation_rules, options, ordering]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.CHARACTERISTIC_CREATE,
            entityType: ENTITY_TYPES.CHARACTERISTIC,
            entityId: result.rows[0].id,
            newValues: { 
                product_type_id: productTypeId,
                name,
                code,
                type,
                is_required,
                default_value,
                validation_rules,
                options,
                ordering
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            characteristic: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating characteristic:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating characteristic'
        });
    } finally {
        client.release();
    }
});

// Update characteristic
router.put('/:productTypeId/characteristics/:characteristicId', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { productTypeId, characteristicId } = req.params;
        const {
            name,
            code,
            type,
            is_required,
            default_value,
            validation_rules,
            options
        } = req.body;

        await client.query('BEGIN');

        // Get old characteristic data
        const oldData = await client.query(
            'SELECT * FROM products.product_type_characteristics WHERE id = $1 AND product_type_id = $2',
            [characteristicId, productTypeId]
        );

        if (oldData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Characteristic not found'
            });
        }

        // Check code uniqueness if it's being changed
        if (code && code !== oldData.rows[0].code) {
            const codeCheck = await client.query(
                'SELECT id FROM products.product_type_characteristics WHERE product_type_id = $1 AND code = $2 AND id != $3',
                [productTypeId, code, characteristicId]
            );

            if (codeCheck.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Characteristic with this code already exists for this product type'
                });
            }
        }

        // Verify characteristic type if it's being changed
        if (type && type !== oldData.rows[0].type) {
            const typeCheck = await client.query(
                'SELECT value FROM products.characteristic_types WHERE value = $1',
                [type]
            );

            if (typeCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Invalid characteristic type'
                });
            }
        }

        // Update characteristic
        const result = await client.query(
            `UPDATE products.product_type_characteristics
             SET name = COALESCE($1, name),
                 code = COALESCE($2, code),
                 type = COALESCE($3, type),
                 is_required = COALESCE($4, is_required),
                 default_value = COALESCE($5, default_value),
                 validation_rules = COALESCE($6, validation_rules),
                 options = COALESCE($7, options),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $8 AND product_type_id = $9
             RETURNING *`,
            [name, code, type, is_required, default_value, validation_rules, options, characteristicId, productTypeId]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.CHARACTERISTIC_UPDATE,
            entityType: ENTITY_TYPES.CHARACTERISTIC,
            entityId: characteristicId,
            oldValues: oldData.rows[0],
            newValues: result.rows[0],
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            characteristic: result.rows[0]
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
router.delete('/:productTypeId/characteristics/:characteristicId', authenticate, checkPermission('products.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { productTypeId, characteristicId } = req.params;

        await client.query('BEGIN');

        // Get characteristic data for audit
        const characteristicData = await client.query(
            'SELECT * FROM products.product_type_characteristics WHERE id = $1 AND product_type_id = $2',
            [characteristicId, productTypeId]
        );

        if (characteristicData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Characteristic not found'
            });
        }

        // Check if characteristic is used in any products
        const usageCheck = await client.query(
            'SELECT id FROM products.product_characteristic_values WHERE characteristic_id = $1 LIMIT 1',
            [characteristicId]
        );

        if (usageCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete characteristic that is used in products'
            });
        }

        // Delete characteristic
        await client.query(
            'DELETE FROM products.product_type_characteristics WHERE id = $1 AND product_type_id = $2',
            [characteristicId, productTypeId]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.CHARACTERISTIC_DELETE,
            entityType: ENTITY_TYPES.CHARACTERISTIC,
            entityId: characteristicId,
            oldValues: characteristicData.rows[0],
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
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

// Update characteristics order
router.put('/:productTypeId/characteristics/order', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { productTypeId } = req.params;
        const { characteristics } = req.body;

        await client.query('BEGIN');

        // Update order for each characteristic
        for (const char of characteristics) {
            await client.query(
                `UPDATE products.product_type_characteristics
                 SET ordering = $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2 AND product_type_id = $3`,
                [char.ordering, char.id, productTypeId]
            );
        }

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.CHARACTERISTIC_ORDER_UPDATE,
            entityType: ENTITY_TYPES.PRODUCT_TYPE,
            entityId: productTypeId,
            newValues: { characteristics },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Characteristics order updated successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating characteristics order:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating characteristics order'
        });
    } finally {
        client.release();
    }
});

// Validate characteristic value
router.post('/validate', authenticate, async (req, res) => {
    try {
        const { type, value, validation_rules } = req.body;

        let isValid = true;
        let errors = [];

        switch (type) {
            case 'string':
                if (validation_rules?.minLength && value.length < validation_rules.minLength) {
                    isValid = false;
                    errors.push(`Minimum length is ${validation_rules.minLength}`);
                }
                if (validation_rules?.maxLength && value.length > validation_rules.maxLength) {
                    isValid = false;
                    errors.push(`Maximum length is ${validation_rules.maxLength}`);
                }
                if (validation_rules?.pattern && !new RegExp(validation_rules.pattern).test(value)) {
                    isValid = false;
                    errors.push('Value does not match required pattern');
                }
                break;

            case 'number':
                const numValue = Number(value);
                if (isNaN(numValue)) {
                    isValid = false;
                    errors.push('Value must be a number');
                } else {
                    if (validation_rules?.min !== undefined && numValue < validation_rules.min) {
                        isValid = false;
                        errors.push(`Minimum value is ${validation_rules.min}`);
                    }
                    if (validation_rules?.max !== undefined && numValue > validation_rules.max) {
                        isValid = false;
                        errors.push(`Maximum value is ${validation_rules.max}`);
                    }
                }
                break;

            case 'date':
                const dateValue = new Date(value);
                if (isNaN(dateValue.getTime())) {
                    isValid = false;
                    errors.push('Invalid date format');
                } else {
                    if (validation_rules?.min && new Date(value) < new Date(validation_rules.min)) {
                        isValid = false;
                        errors.push(`Date must be after ${validation_rules.min}`);
                    }
                    if (validation_rules?.max && new Date(value) > new Date(validation_rules.max)) {
                        isValid = false;
                        errors.push(`Date must be before ${validation_rules.max}`);
                    }
                }
                break;

            case 'boolean':
                if (typeof value !== 'boolean') {
                    isValid = false;
                    errors.push('Value must be a boolean');
                }
                break;

            case 'select':
                if (!validation_rules?.options?.includes(value)) {
                    isValid = false;
                    errors.push('Value must be one of the predefined options');
                }
                break;

            default:
                isValid = false;
                errors.push('Unknown characteristic type');
        }

        res.json({
            success: true,
            isValid,
            errors
        });
    } catch (error) {
        console.error('Error validating characteristic:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while validating characteristic'
        });
    }
});

module.exports = router;