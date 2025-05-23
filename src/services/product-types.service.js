const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');



class ProductTypeService {
    static getBaseQuery() {
        return `
        SELECT 
            pt.*,
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', c.id,
                        'name', c.name,
                        'code', c.code,
                        'type', c.type,
                        'is_required', c.is_required,
                        'default_value', c.default_value,
                        'validation_rules', c.validation_rules,
                        'options', c.options,
                        'ordering', c.ordering
                    ) ORDER BY c.ordering
                )
                FROM products.product_type_characteristics c
                WHERE c.product_type_id = pt.id
            ) as characteristics,
            COUNT(DISTINCT p.id) as products_count
        FROM products.product_types pt
        LEFT JOIN products.models m ON m.product_type_id = pt.id
        LEFT JOIN products.products p ON p.model_id = m.id
    `;
}
static async getProductTypes(filters) {
    const {
        page = 1,
        perPage = 10,
        sortBy = 'name',
        descending = false,
        search = ''
    } = filters;

    // Маппінг полів для сортування
    const sortMapping = {
        'name': 'pt.name',
        'code': 'pt.code',
        'products_count': 'products_count',
        'is_active': 'pt.is_active'
    };

    const sortByColumn = sortMapping[sortBy] || 'pt.name';
    const orderDirection = descending === true || descending === 'true' ? 'DESC' : 'ASC';

    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (search) {
        conditions.push(`(
            pt.name ILIKE $${paramIndex} OR 
            pt.code ILIKE $${paramIndex} OR 
            pt.description ILIKE $${paramIndex}
        )`);
        params.push(`%${search}%`);
        paramIndex++;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    
    // Оновлений запит з правильним ORDER BY
    let query, queryParams;

    if (perPage === 'All') {
        // Запит без обмеження, якщо perPage === 'All'
        query = `
            ${this.getBaseQuery()}
            ${whereClause}
            GROUP BY pt.id
            ORDER BY ${sortByColumn} ${orderDirection}
        `;
        queryParams = params;
    } else {
        // Запит з обмеженням для звичайної пагінації
        query = `
            ${this.getBaseQuery()}
            ${whereClause}
            GROUP BY pt.id
            ORDER BY ${sortByColumn} ${orderDirection}
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        queryParams = [...params, parseInt(perPage), (parseInt(page) - 1) * parseInt(perPage)];
    }
    
    const [productTypes, total] = await Promise.all([
        pool.query(query, queryParams),
        pool.query(`
            SELECT COUNT(*)
            FROM products.product_types pt
            ${whereClause}
        `, params)
    ]);

    return {
        success: true,
        productTypes: productTypes.rows,
        total: parseInt(total.rows[0].count)
    };
}

    static async getProductTypeById(id) {
        const query = `${this.getBaseQuery()}
            WHERE pt.id = $1
            GROUP BY pt.id`;
        
        const result = await pool.query(query, [id]);
        return result.rows[0];
    }

    static async checkCodeExists(client, code, excludeId = null) {
        const query = excludeId
            ? 'SELECT id FROM products.product_types WHERE code = $1 AND id != $2'
            : 'SELECT id FROM products.product_types WHERE code = $1';
        
        const params = excludeId ? [code, excludeId] : [code];
        const result = await client.query(query, params);
        return result.rows.length > 0;
    }

    static async createProductType(client, { 
        name, code, description, characteristics = [], userId, ipAddress, req 
    }) {
        // Create product type
        const result = await client.query(
            `INSERT INTO products.product_types (name, code, description)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [name, code, description]
        );

        // Add characteristics if provided
        if (characteristics.length > 0) {
            for (const [index, char] of characteristics.entries()) {
                await client.query(
                    `INSERT INTO products.product_type_characteristics (
                        product_type_id, name, code, type, is_required,
                        default_value, validation_rules, options, ordering
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [
                        result.rows[0].id,
                        char.name,
                        char.code,
                        char.type,
                        char.is_required || false,
                        char.default_value,
                        char.validation_rules,
                        char.options,
                        char.ordering || index
                    ]
                );
            }
        }

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT_TYPE.CREATE,
            entityType: ENTITY_TYPES.PRODUCT_TYPE,
            entityId: result.rows[0].id,
            newValues: {
                name, code, description, characteristics
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return this.getProductTypeById(result.rows[0].id);
    }

    static async updateProductType(client, { 
        id, data, oldProductType, userId, ipAddress, req 
    }) {
        const { name, code, description, is_active } = data;

        const result = await client.query(
            `UPDATE products.product_types 
             SET name = COALESCE($1, name),
                 code = COALESCE($2, code),
                 description = COALESCE($3, description),
                 is_active = COALESCE($4, is_active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $5
             RETURNING *`,
            [name, code, description, is_active, id]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT_TYPE.UPDATE,
            entityType: ENTITY_TYPES.PRODUCT_TYPE,
            entityId: id,
            oldValues: oldProductType,
            newValues: data,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return this.getProductTypeById(id);
    }

    static async canDeleteProductType(client, id) {
        // Check if type exists
        const productType = await this.getProductTypeById(id);
        if (!productType) {
            return {
                canDelete: false,
                message: 'Product type not found'
            };
        }
    
        // Check if type has models
        const modelsCheck = await client.query(
            'SELECT id FROM products.models WHERE product_type_id = $1 LIMIT 1',
            [id]
        );
        
        if (modelsCheck.rows.length > 0) {
            return {
                canDelete: false,
                message: 'Cannot delete product type with existing models',
                productType
            };
        }
         return {
            canDelete: true,
            productType
        };
    }
    static async deleteProductType(client, { 
        id, oldProductType, userId, ipAddress, req 
    }) {
        // Delete characteristics first
        await client.query(
            'DELETE FROM products.product_type_characteristics WHERE product_type_id = $1',
            [id]
        );

        // Delete product type
        await client.query(
            'DELETE FROM products.product_types WHERE id = $1',
            [id]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT_TYPE.DELETE,
            entityType: ENTITY_TYPES.PRODUCT_TYPE,
            entityId: id,
            oldValues: oldProductType,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
    }

    // Characteristics methods
    static async getCharacteristicById(id) {
        const result = await pool.query(
            `SELECT * FROM products.product_type_characteristics WHERE id = $1`,
            [id]
        );
        return result.rows[0];
    }

    static async checkCharacteristicCodeExists(client, productTypeId, code, excludeId = null) {
        const query = excludeId
            ? `SELECT id FROM products.product_type_characteristics 
               WHERE product_type_id = $1 AND code = $2 AND id != $3`
            : `SELECT id FROM products.product_type_characteristics 
               WHERE product_type_id = $1 AND code = $2`;
        
        const params = excludeId ? [productTypeId, code, excludeId] : [productTypeId, code];
        const result = await client.query(query, params);
        return result.rows.length > 0;
    }

    static async addCharacteristic(client, { 
        productTypeId, data, userId, ipAddress, req 
    }) {
        const {
            name,
            code,
            type,
            is_required = false,
            default_value = null,
            validation_rules = null,
            options = null,
            ordering = 0
        } = data;

        // Get max ordering if not provided
        let finalOrdering = ordering;
        if (!ordering) {
            const maxResult = await client.query(
                `SELECT MAX(ordering) as max_order 
                 FROM products.product_type_characteristics 
                 WHERE product_type_id = $1`,
                [productTypeId]
            );
            finalOrdering = (maxResult.rows[0].max_order || 0) + 1;
        }

        const result = await client.query(
            `INSERT INTO products.product_type_characteristics (
                product_type_id, name, code, type, is_required,
                default_value, validation_rules, options, ordering
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [
                productTypeId,
                name,
                code,
                type,
                is_required,
                default_value,
                validation_rules,
                options,
                finalOrdering
            ]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT_TYPE.CHARACTERISTIC_CREATE,
            entityType: ENTITY_TYPES.PRODUCT_CHARACTERISTIC,
            entityId: result.rows[0].id,
            newValues: data,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return result.rows[0];
    }

    static async updateCharacteristic(client, { 
        characteristicId, data, oldCharacteristic, userId, ipAddress, req 
    }) {
        const {
            name,
            code,
            type,
            is_required,
            default_value,
            validation_rules,
            options,
            ordering
        } = data;

        const result = await client.query(
            `UPDATE products.product_type_characteristics 
             SET name = COALESCE($1, name),
                 code = COALESCE($2, code),
                 type = COALESCE($3, type),
                 is_required = COALESCE($4, is_required),
                 default_value = COALESCE($5, default_value),
                 validation_rules = COALESCE($6, validation_rules),
                 options = COALESCE($7, options),
                 ordering = COALESCE($8, ordering),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $9
             RETURNING *`,
            [
                name, code, type, is_required, default_value,
                validation_rules, options, ordering, characteristicId
            ]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT_TYPE.CHARACTERISTIC_UPDATE,
            entityType: ENTITY_TYPES.PRODUCT_CHARACTERISTIC,
            entityId: characteristicId,
            oldValues: oldCharacteristic,
            newValues: data,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return result.rows[0];
    }

    static async canDeleteCharacteristic(client, id) {
        // Check if characteristic exists
        const characteristic = await this.getCharacteristicById(id);
        if (!characteristic) {
            return {
                canDelete: false,
                message: 'Characteristic not found'
            };
        }

        // Check if characteristic has values
        const valuesCheck = await client.query(
            'SELECT id FROM products.product_characteristic_values WHERE characteristic_id = $1 LIMIT 1',
            [id]
        );

        if (valuesCheck.rows.length > 0) {
            return {
                canDelete: false,
                message: 'Cannot delete characteristic that has values',
                characteristic
            };
        }

        return {
            canDelete: true,
            characteristic
        };
    }

    static async deleteCharacteristic(client, { 
        characteristicId, oldCharacteristic, userId, ipAddress, req 
    }) {
        await client.query(
            'DELETE FROM products.product_type_characteristics WHERE id = $1',
            [characteristicId]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.PRODUCT_TYPE.CHARACTERISTIC_DELETE,
            entityType: ENTITY_TYPES.PRODUCT_CHARACTERISTIC,
            entityId: characteristicId,
            oldValues: oldCharacteristic,
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
    }
    static async getProductTypeCodes() {
        try {
            const result = await pool.query(`
                SELECT 
                    value,
                    label,
                    description,
                    is_active
                FROM products.product_type_codes
                WHERE is_active = true
                ORDER BY label
            `);
            
            // Якщо немає даних, повертаємо базовий набір
            if (result.rows.length === 0) {
                return [
                    { value: 'TEST', label: 'TEST - Test', description: 'Test' }
                ];
            }
            
            return result.rows;
        } catch (error) {
            console.error('Error in getProductTypeCodes:', error);
            return [
                { value: 'TEST', label: 'TEST - Test', description: 'Test' }
            ];
        }
    }
    static async getTypeCharacteristics(typeId) {
        try {
            const result = await pool.query(`
                SELECT 
                    ptc.id,
                    ptc.name,
                    ptc.code,
                    ptc.type,
                    ptc.is_required,
                    ptc.default_value,
                    ptc.validation_rules,
                    ptc.options,
                    ptc.ordering
                FROM products.product_type_characteristics ptc
                WHERE ptc.product_type_id = $1
                ORDER BY ptc.ordering
            `, [typeId]);
    
            return result.rows;
        } catch (error) {
            console.error('Error in getTypeCharacteristics:', error);
            throw error;
        }
    }
}

module.exports = ProductTypeService;