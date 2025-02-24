const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');


const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
      const uploadDir = path.join(process.env.UPLOAD_DIR, 'models');
      try {
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
      const ext = path.extname(file.originalname);
      cb(null, `model-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG and GIF are allowed'));
    }
};

const upload = multer({
    storage,
    limits: {
      fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter
});

// Get models list with filtering and pagination
router.get('/', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        let { 
            page = 1, 
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            manufacturer = '',
            productType = '',
            isActive = ''
        } = req.query;

        const sortMapping = {
            'name': 'm.name',
            'manufacturer_name': 'man.name',
            'products_count': 'products_count',
            'in_stock_count': 'in_stock_count',
            'installed_count': 'installed_count',
            'is_active': 'm.is_active'
        };

        const sortByColumn = sortMapping[sortBy] || 'm.name';
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

        if (productType) {
            conditions.push(`m.product_type_id = $${paramIndex}`);
            params.push(productType);
            paramIndex++;
        }
        
        if (search) {
            conditions.push(`(m.name ILIKE $${paramIndex} OR m.description ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        let modelsQuery = `
        SELECT 
            m.*,
            man.name as manufacturer_name,
            pt.name as product_type_name,
            COUNT(DISTINCT p.id) as products_count,
            COUNT(DISTINCT CASE WHEN p.current_status = 'in_stock' THEN p.id END) as in_stock_count,
            COUNT(DISTINCT CASE WHEN p.current_status = 'installed' THEN p.id END) as installed_count
        FROM products.models m
        JOIN products.manufacturers man ON m.manufacturer_id = man.id
        JOIN products.product_types pt ON m.product_type_id = pt.id
        LEFT JOIN products.products p ON m.id = p.model_id
        ${whereClause}
        GROUP BY 
            m.id, 
            m.name, 
            m.description,
            m.manufacturer_id,
            m.product_type_id,
            m.image_url,
            m.is_active,
            m.created_at,
            m.updated_at,
            man.name, 
            pt.name
        ORDER BY ${sortByColumn} ${orderDirection}, m.name ASC
        `;

        if (perPage) {
            modelsQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(perPage, offset);
        }

        const countQuery = `
            SELECT COUNT(*) 
            FROM products.models m
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            JOIN products.product_types pt ON m.product_type_id = pt.id
            ${whereClause}
        `;

        const [countResult, modelsResult] = await Promise.all([
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : []),
            pool.query(modelsQuery, params)
        ]);

        res.json({
            success: true,
            models: modelsResult.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching models'
        });
    }
});

// Get single model with products
router.get('/:id', authenticate, checkPermission('products.read'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT 
                m.*,
                man.name as manufacturer_name,
                pt.name as product_type_name,
                COUNT(DISTINCT p.id) as products_count,
                COUNT(DISTINCT CASE WHEN p.current_status = 'in_stock' THEN p.id END) as in_stock_count,
                COUNT(DISTINCT CASE WHEN p.current_status = 'installed' THEN p.id END) as installed_count,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', p.id,
                        'sku', p.sku,
                        'current_status', p.current_status,
                        'warranty_end', p.warranty_end
                    )
                ) FILTER (WHERE p.id IS NOT NULL) as products
            FROM products.models m
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            JOIN products.product_types pt ON m.product_type_id = pt.id
            LEFT JOIN products.products p ON m.id = p.model_id
            WHERE m.id = $1
            GROUP BY 
                m.id, 
                man.name, 
                pt.name,
                m.description,
                m.manufacturer_id,
                m.product_type_id,
                m.image_url,
                m.is_active,
                m.created_at,
                m.updated_at
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Model not found'
            });
        }

        res.json({
            success: true,
            model: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching model:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching model'
        });
    }
});

// Create model
router.post('/', authenticate, checkPermission('products.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            name, 
            description, 
            manufacturer_id,
            product_type_id,
            image_url = null
        } = req.body;

        await client.query('BEGIN');

        const typeCheck = await client.query(
            'SELECT id FROM products.product_types WHERE id = $1 AND is_active = true',
            [product_type_id]
        );        
        if (typeCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Product type not found or inactive'
            });
        }

        // Check if manufacturer exists and is active
        const manufacturerCheck = await client.query(
            'SELECT id FROM products.manufacturers WHERE id = $1 AND is_active = true',
            [manufacturer_id]
        );

        if (manufacturerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Manufacturer not found or inactive'
            });
        }

        // Check if name exists for this manufacturer
        const nameCheck = await client.query(
            'SELECT id FROM products.models WHERE name = $1 AND manufacturer_id = $2',
            [name, manufacturer_id]
        );

        if (nameCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Model with this name already exists for this manufacturer'
            });
        }
        if (product_type_id) {
            const typeCheck = await client.query(
                'SELECT id FROM products.product_types WHERE id = $1 AND is_active = true',
                [product_type_id]
            );
            if (typeCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Product type not found or inactive'
                });
            }
        }

        // Create model
        const result = await client.query(
            `INSERT INTO products.models (name, description, manufacturer_id, product_type_id, image_url)
 VALUES ($1, $2, $3, $4, $5)
 RETURNING *`,
[name, description, manufacturer_id, product_type_id, image_url]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.MODEL_CREATE,
            entityType: ENTITY_TYPES.MODEL,
            entityId: result.rows[0].id,
            newValues: { 
                name, description, manufacturer_id, product_type_id, image_url
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            model: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating model:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating model'
        });
    } finally {
        client.release();
    }
});

// Update model
router.put('/:id', authenticate, checkPermission('products.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { 
            name, 
            description,
            manufacturer_id,
            product_type_id,
            image_url,
            is_active
        } = req.body;

        await client.query('BEGIN');

        // Get old model data
        const oldData = await client.query(
            'SELECT * FROM products.models WHERE id = $1',
            [id]
        );

        if (oldData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Model not found'
            });
        }

        if (product_type_id && product_type_id !== oldData.rows[0].product_type_id) {
            const typeCheck = await client.query(
                'SELECT id FROM products.product_types WHERE id = $1 AND is_active = true',
                [product_type_id]
            );
        
            if (typeCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Product type not found or inactive'
                });
            }
        }

        // If manufacturer is changing, check if it exists and is active
        if (manufacturer_id && manufacturer_id !== oldData.rows[0].manufacturer_id) {
            const manufacturerCheck = await client.query(
                'SELECT id FROM products.manufacturers WHERE id = $1 AND is_active = true',
                [manufacturer_id]
            );

            if (manufacturerCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Manufacturer not found or inactive'
                });
            }
        }

        // Check name uniqueness if it's being changed
        if (name && name !== oldData.rows[0].name) {
            const nameCheck = await client.query(
                'SELECT id FROM products.models WHERE name = $1 AND manufacturer_id = $2 AND id != $3',
                [name, manufacturer_id || oldData.rows[0].manufacturer_id, id]
            );

            if (nameCheck.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Model with this name already exists for this manufacturer'
                });
            }
        }

        // Update model
        const result = await client.query(
            `UPDATE products.models 
SET name = COALESCE($1, name),
    description = COALESCE($2, description),
    manufacturer_id = COALESCE($3, manufacturer_id),
    product_type_id = COALESCE($4, product_type_id),
    image_url = COALESCE($5, image_url),
    is_active = COALESCE($6, is_active),
    updated_at = CURRENT_TIMESTAMP
WHERE id = $7
RETURNING *`,
[name, description, manufacturer_id, product_type_id, image_url, is_active, id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.MODEL_UPDATE,
            entityType: ENTITY_TYPES.MODEL,
            entityId: id,
            oldValues: oldData.rows[0],
            newValues: { 
                name, description, manufacturer_id, product_type_id, image_url, is_active
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            model: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating model:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating model'
        });
    } finally {
        client.release();
    }
});

// В models.js додайте новий endpoint для завантаження зображення
router.post('/:id/image', authenticate, checkPermission('products.update'), upload.single('image'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false,
                message: 'No file uploaded' 
            });
        }

        const { id } = req.params;

        await client.query('BEGIN');

        // Отримуємо інформацію про стару картинку
        const oldModel = await client.query(
            'SELECT image_url FROM products.models WHERE id = $1',
            [id]
        );

        // Якщо є стара картинка - видаляємо її
        if (oldModel.rows[0]?.image_url) {
            const oldImagePath = path.join(process.env.UPLOAD_DIR, oldModel.rows[0].image_url);
            try {
                await fs.unlink(oldImagePath);
            } catch (err) {
                console.error('Error deleting old image:', err);
            }
        }

        const imageUrl = path.relative(process.env.UPLOAD_DIR, req.file.path);
        
        // Оновлюємо URL зображення в базі даних
        await client.query(
            'UPDATE products.models SET image_url = $1 WHERE id = $2 RETURNING *',
            [imageUrl, id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.MODEL_IMAGE_UPDATE,
            entityType: ENTITY_TYPES.MODEL,
            entityId: id,
            oldValues: { image_url: oldModel.rows[0]?.image_url },
            newValues: { image_url: imageUrl },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({ 
            success: true,
            image_url: imageUrl
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error uploading image:', error);
        res.status(500).json({ 
            success: false,
            message: 'Server error while uploading image' 
        });
    } finally {
        client.release();
    }
});

// Delete model
router.delete('/:id', authenticate, checkPermission('products.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        await client.query('BEGIN');

        // Get model data for audit
        const modelData = await client.query(
            'SELECT * FROM products.models WHERE id = $1',
            [id]
        );

        if (modelData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Model not found'
            });
        }

        // Check if model has products
        const productsCheck = await client.query(
            'SELECT id FROM products.products WHERE model_id = $1 LIMIT 1',
            [id]
        );

        if (productsCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Cannot delete model with existing products'
            });
        }

        // Delete model
        await client.query(
            'DELETE FROM products.models WHERE id = $1',
            [id]
        );

        await AuditService.log({
            userId: req.user.userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.MODEL_DELETE,
            entityType: ENTITY_TYPES.MODEL,
            entityId: id,
            oldValues: modelData.rows[0],
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Model deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting model:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting model'
        });
    } finally {
        client.release();
    }
});

module.exports = router;