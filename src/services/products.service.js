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
                man.id as manufacturer_id,
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
            JOIN products.product_types pt ON m.product_type_id = pt.id
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
        console.log('Received filters:', filters);
    
        const {
            page = 1,
            perPage = 10,
            sortBy = 'sku',
            sort_desc = 0,
            search = '',
            manufacturer_id = '',
            model_id = '', // Added model_id filter
            current_status = '',
            is_own = null,
        } = filters;
    
        let conditions = [];
        let params = [];
        let paramIndex = 1;
    
        if (search) {
            conditions.push(`(
                p.sku ILIKE $${paramIndex} OR
                m.name ILIKE $${paramIndex} OR
                man.name ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }
    
        if (manufacturer_id) {
            conditions.push(`man.id = $${paramIndex}`);
            params.push(manufacturer_id);
            paramIndex++;
        }
    
        // Add model_id filter
        if (model_id) {
            conditions.push(`m.id = $${paramIndex}`);
            params.push(model_id);
            paramIndex++;
        }
    
        if (current_status) {
            conditions.push(`p.current_status = $${paramIndex}`);
            params.push(current_status);
            paramIndex++;
        }
    
        if (is_own !== null) {
            conditions.push(`p.is_own = $${paramIndex}`);
            params.push(is_own);
            paramIndex++;
        }
    
        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        
        const isDescending = Number(sort_desc) === 1;
        console.log('Sort parameters:', { sortBy, sort_desc, isDescending });
    
        let orderByClause;
        switch (sortBy) {
            case 'model_name':
                orderByClause = `m.name ${isDescending ? 'DESC' : 'ASC'}`;
                break;
            case 'manufacturer_name':
                orderByClause = `man.name ${isDescending ? 'DESC' : 'ASC'}`;
                break;
            case 'is_own':
            case 'current_status':
            case 'sku':
                orderByClause = `p.${sortBy} ${isDescending ? 'DESC' : 'ASC'}`;
                break;
            default:
                orderByClause = `p.sku ${isDescending ? 'DESC' : 'ASC'}`;
        }
    
        console.log('Final ORDER BY clause:', orderByClause);
    
        // Обробка параметра perPage для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const limitClause = limit ? `LIMIT $${paramIndex} OFFSET $${paramIndex + 1}` : '';
        const queryParams = limit 
            ? [...params, limit, (page - 1) * limit] 
            : params;
    
        const query = `${this.getBaseQuery()}
            ${whereClause}
            GROUP BY p.id, m.name, m.description, man.id, man.name, s.name, pt.name, st.quantity
            ORDER BY ${orderByClause}
            ${limitClause}`;
    
        const [products, total] = await Promise.all([
            pool.query(query, queryParams),
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
            GROUP BY p.id, m.name, m.description, man.id, man.name, s.name, pt.name, st.quantity`;
        
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
        warehouse_id,
        is_own,
        characteristics = {}, 
        created_by,
        userId, 
        ipAddress, 
        req
    }) {
        try {
            if (!warehouse_id) {
                throw new Error('Warehouse ID is required');
            }

            // Валідація характеристик
            const { isValid, errors } = await validateProductCharacteristics(
                client, 
                product_type_id, 
                characteristics
            );

            if (!isValid) {
                throw new Error(`Validation failed: ${errors.join(', ')}`);
            }

            // Створюємо продукт
            const productResult = await client.query(
                `INSERT INTO products.products (
                    sku, 
                    model_id, 
                    supplier_id, 
                    current_status,
                    is_own
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [
                    sku,
                    model_id,
                    supplier_id,
                    'in_stock',
                    is_own
                ]
            );

            const productId = productResult.rows[0].id;
            
            // Створюємо запис в stock
            await client.query(
                `INSERT INTO warehouses.stock (
                    warehouse_id,
                    product_id,
                    quantity
                )
                VALUES ($1, $2, $3)`,
                [warehouse_id, productId, 1]
            );

            // Створюємо запис в stock_movements
            await client.query(
                `INSERT INTO warehouses.stock_movements (
                    product_id,
                    to_warehouse_id,
                    quantity,
                    type,
                    created_by
                )
                VALUES ($1, $2, $3, $4, $5)`,
                [productId, warehouse_id, 1, 'transfer', created_by]
            );

            // Зберігаємо характеристики
            const typeCharacteristics = await client.query(
                `SELECT * FROM products.product_type_characteristics 
                WHERE product_type_id = $1`,
                [product_type_id]
            );

            // Використовуємо функцію saveCharacteristics замість власної логіки
            await this.saveCharacteristics(client, productId, characteristics, typeCharacteristics);

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
                    warehouse_id,
                    characteristics
                },
                ipAddress,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return await this.getProductById(productId);
        } catch (error) {
            throw error;
        }
    }

    static async updateProduct(client, { id, data, oldProduct, userId, ipAddress, req }) {
        const {
            model_id, supplier_id, is_own,
            current_status, current_object_id,
            characteristics, product_type_id
        } = data;

        // Оновлюємо продукт
        const result = await client.query(
            `UPDATE products.products 
             SET model_id = COALESCE($1, model_id),
                 supplier_id = COALESCE($2, supplier_id),
                 is_own = COALESCE($3, is_own),
                 current_status = COALESCE($4, current_status),
                 current_object_id = COALESCE($5, current_object_id),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $6
             RETURNING *`,
            [
                model_id, supplier_id, is_own,
                current_status, current_object_id, id
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