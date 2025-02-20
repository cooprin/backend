const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const { 
    validateProductCharacteristics,
    formatCharacteristicValue 
} = require('../utils/characteristicsUtils');

class ProductService {
    // Допоміжні функції
    static getBaseQuery() {
        return `
            SELECT 
                p.*,
                m.name as model_name,
                m.description as model_description,
                man.name as manufacturer_name,
                s.name as supplier_name,
                pt.name as product_type_name,
                COALESCE(st.quantity, 0) as stock_quantity,
                jsonb_object_agg(
                    COALESCE(ptc.code, 'none'),
                    jsonb_build_object(
                        'name', ptc.name,
                        'type', ptc.type,
                        'value', pcv.value
                    )
                ) FILTER (WHERE ptc.id IS NOT NULL) as characteristics
            FROM products.products p
            JOIN products.models m ON p.model_id = m.id
            JOIN products.manufacturers man ON m.manufacturer_id = man.id
            JOIN products.suppliers s ON p.supplier_id = s.id
            JOIN products.product_types pt ON p.product_type_id = pt.id
            LEFT JOIN warehouses.stock st ON p.id = st.product_id
            LEFT JOIN products.product_type_characteristics ptc ON pt.id = ptc.product_type_id
            LEFT JOIN products.product_characteristic_values pcv ON p.id = pcv.product_id AND ptc.id = pcv.characteristic_id
        `;
    }

    static async saveCharacteristics(client, productId, characteristics, typeCharacteristics) {
        // Видаляємо старі значення
        await client.query(
            'DELETE FROM products.product_characteristic_values WHERE product_id = $1',
            [productId]
        );

        // Додаємо нові значення
        for (const tc of typeCharacteristics.rows) {
            const value = characteristics[tc.code];
            if (value !== undefined && value !== null) {
                const formattedValue = formatCharacteristicValue(tc.type, value);
                if (formattedValue !== null) {
                    await client.query(
                        `INSERT INTO products.product_characteristic_values 
                         (product_id, characteristic_id, value)
                         VALUES ($1, $2, $3)`,
                        [productId, tc.id, formattedValue.toString()]
                    );
                }
            }
        }
    }

    // Основні методи
    static async getProducts(filters) {
        const {
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
            isOwn = '',
            productType = '',
            characteristic = ''
        } = filters;

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

        // Додаємо інші фільтри...
        // Код фільтрації такий самий як був у products.js

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const query = `${this.getBaseQuery()}
            ${whereClause}
            GROUP BY p.id, m.name, m.description, man.name, s.name, pt.name, st.quantity
            ORDER BY p.${sortBy} ${descending ? 'DESC' : 'ASC'}
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

        const [products, total] = await Promise.all([
            pool.query(query, [...params, perPage, (page - 1) * perPage]),
            pool.query(`
                SELECT COUNT(DISTINCT p.id)
                FROM products.products p
                JOIN products.models m ON p.model_id = m.id
                JOIN products.manufacturers man ON m.manufacturer_id = man.id
                JOIN products.suppliers s ON p.supplier_id = s.id
                ${whereClause}
            `, params)
        ]);

        return {
            success: true,
            products: products.rows,
            total: parseInt(total.rows[0].count)
        };
    }

    static async getProductById(id) {
        const query = `${this.getBaseQuery()}
            WHERE p.id = $1
            GROUP BY p.id, m.name, m.description, man.name, s.name, pt.name, st.quantity`;
        
        const result = await pool.query(query, [id]);
        return result.rows[0];
    }

    static async getTypeCharacteristics(typeId) {
        const result = await pool.query(`
            SELECT 
                ptc.*,
                COUNT(pcv.id) as usage_count
            FROM products.product_type_characteristics ptc
            LEFT JOIN products.product_characteristic_values pcv ON ptc.id = pcv.characteristic_id
            WHERE ptc.product_type_id = $1
            GROUP BY ptc.id
            ORDER BY ptc.ordering
        `, [typeId]);

        return result.rows;
    }

    static async checkSkuExists(client, sku) {
        const result = await client.query(
            'SELECT id FROM products.products WHERE sku = $1',
            [sku]
        );
        return result.rows.length > 0;
    }


    static async createProduct(client, { 
        sku, 
        model_id, 
        supplier_id, 
        product_type_id,
        characteristics = {}, 
        userId, 
        ipAddress, 
        req
    }) {
        try {
            console.log('Creating product with data:', {
                sku,
                model_id,
                supplier_id,
                product_type_id,
                characteristics
            });
    
            // Валідація характеристик
            const { isValid, errors } = await validateProductCharacteristics(
                client, 
                product_type_id, 
                characteristics
            );
    
            if (!isValid) {
                console.error('Validation errors:', errors);
                throw new Error(`Validation failed: ${errors.join(', ')}`);
            }
    
            // Створюємо продукт
            const productResult = await client.query(
                `INSERT INTO products.products (
                    sku, 
                    model_id, 
                    supplier_id, 
                    product_type_id,
                    current_status
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [
                    sku,
                    model_id,
                    supplier_id,
                    product_type_id,
                    'in_stock'
                ]
            );
    
            const productId = productResult.rows[0].id;
    
            // Зберігаємо характеристики
            const typeCharacteristics = await client.query(
                `SELECT * FROM products.product_type_characteristics 
                 WHERE product_type_id = $1`,
                [product_type_id]
            );
    
            for (const tc of typeCharacteristics.rows) {
                const value = characteristics[tc.code];
                if (value !== undefined && value !== null) {
                    const formattedValue = typeof value === 'boolean' ? value.toString() : value;
                    
                    console.log(`Saving characteristic ${tc.code}:`, {
                        productId,
                        characteristicId: tc.id,
                        value: formattedValue,
                    });
    
                    await client.query(
                        `INSERT INTO products.product_characteristic_values 
                         (product_id, characteristic_id, value)
                         VALUES ($1, $2, $3)`,
                        [productId, tc.id, formattedValue]
                    );
                }
            }
    
            // Логуємо
            await AuditService.log({
                userId,
                actionType: AUDIT_LOG_TYPES.PRODUCT.CREATE,
                entityType: ENTITY_TYPES.PRODUCT,
                entityId: productId,
                newValues: {
                    sku,
                    model_id,
                    supplier_id,
                    product_type_id,
                    characteristics
                },
                ipAddress,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
    
            return await this.getProductById(productId);
        } catch (error) {
            console.error('Error in createProduct:', error);
            throw error;
        }
    }

    static async updateProduct(client, { id, data, oldProduct, userId, ipAddress, req }) {
        const {
            model_id, supplier_id, product_type_id, is_own,
            purchase_date, supplier_warranty_end, warranty_end,
            sale_date, current_status, current_object_id,
            characteristics
        } = data;

        // Оновлюємо продукт
        const result = await client.query(
            `UPDATE products.products 
             SET model_id = COALESCE($1, model_id),
                 supplier_id = COALESCE($2, supplier_id),
                 product_type_id = COALESCE($3, product_type_id),
                 is_own = COALESCE($4, is_own),
                 purchase_date = COALESCE($5, purchase_date),
                 supplier_warranty_end = COALESCE($6, supplier_warranty_end),
                 warranty_end = COALESCE($7, warranty_end),
                 sale_date = COALESCE($8, sale_date),
                 current_status = COALESCE($9, current_status),
                 current_object_id = COALESCE($10, current_object_id),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $11
             RETURNING *`,
            [
                model_id, supplier_id, product_type_id, is_own,
                purchase_date, supplier_warranty_end, warranty_end,
                sale_date, current_status, current_object_id, id
            ]
        );

        // Оновлюємо характеристики якщо вони надані
        if (characteristics) {
            const typeCharacteristics = await client.query(
                `SELECT * FROM products.product_type_characteristics 
                 WHERE product_type_id = $1`,
                [product_type_id || oldProduct.product_type_id]
            );

            await this.saveCharacteristics(
                client, 
                id, 
                characteristics, 
                typeCharacteristics
            );
        }

        // Логуємо аудит
        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.UPDATE,
            entityType: ENTITY_TYPES.PRODUCT,
            entityId: id,
            oldValues: oldProduct,
            newValues: data,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        // Повертаємо оновлений продукт
        return this.getProductById(id);
    }

    static async updateProductStatus(client, { 
        id, status, objectId, oldProduct, userId, ipAddress, req 
    }) {
        const result = await client.query(
            `UPDATE products.products 
             SET current_status = $1,
                 current_object_id = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING *`,
            [status, objectId, id]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.STATUS_CHANGE,
            entityType: ENTITY_TYPES.PRODUCT,
            entityId: id,
            oldValues: {
                status: oldProduct.current_status,
                object_id: oldProduct.current_object_id
            },
            newValues: { status, object_id: objectId },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return result.rows[0];
    }

    static async canDeleteProduct(client, id) {
        // Перевіряємо чи продукт існує
        const product = await this.getProductById(id);
        if (!product) {
            return {
                canDelete: false,
                message: 'Product not found'
            };
        }

        // Перевіряємо чи є продукт на складі
        const stockCheck = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE product_id = $1 AND quantity > 0',
            [id]
        );

        if (stockCheck.rows.length > 0) {
            return {
                canDelete: false,
                message: 'Cannot delete product with existing stock',
                product
            };
        }

        // Перевіряємо чи є історія руху
        const movementsCheck = await client.query(
            'SELECT id FROM warehouses.stock_movements WHERE product_id = $1 LIMIT 1',
            [id]
        );

        if (movementsCheck.rows.length > 0) {
            return {
                canDelete: false,
                message: 'Cannot delete product with movement history',
                product
            };
        }

        return {
            canDelete: true,
            product
        };
    }

    static async deleteProduct(client, { id, oldProduct, userId, ipAddress, req }) {
        // Видаляємо характеристики
        await client.query(
            'DELETE FROM products.product_characteristic_values WHERE product_id = $1',
            [id]
        );

        // Видаляємо записи складу
        await client.query(
            'DELETE FROM warehouses.stock WHERE product_id = $1',
            [id]
        );

        // Видаляємо продукт
        await client.query(
            'DELETE FROM products.products WHERE id = $1',
            [id]
        );

        // Логуємо аудит
        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT.DELETE,
            entityType: ENTITY_TYPES.PRODUCT,
            entityId: id,
            oldValues: oldProduct,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
    }
}

module.exports = ProductService;