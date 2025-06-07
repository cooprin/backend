const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES, PRODUCT_STATUS } = require('../constants/constants');
const ProductService = require('./products.service');

class StockService {
    static getBaseStockQuery() {
        return `
            SELECT 
                s.id,
                s.warehouse_id,
                w.name as warehouse_name,
                s.product_id,
                p.sku,
                m.name as model_name,
                man.name as manufacturer_name,
                p.current_status,
                p.current_object_id,
                s.price,
                jsonb_object_agg(
                    COALESCE(ptc.code, 'none'),
                    jsonb_build_object(
                        'name', ptc.name,
                        'type', ptc.type,
                        'value', pcv.value
                    )
                ) FILTER (WHERE ptc.id IS NOT NULL) as characteristics,
                s.created_at,
                s.updated_at
            FROM warehouses.stock s
            JOIN warehouses.warehouses w ON s.warehouse_id = w.id AND w.is_active = true
            JOIN products.products p ON s.product_id = p.id
            JOIN products.models m ON p.model_id = m.id AND m.is_active = true
            JOIN products.manufacturers man ON m.manufacturer_id = man.id AND man.is_active = true
            LEFT JOIN products.product_type_characteristics ptc ON m.product_type_id = ptc.product_type_id
            LEFT JOIN products.product_characteristic_values pcv ON p.id = pcv.product_id AND ptc.id = pcv.characteristic_id
        `;
    }

    static getBaseMovementsQuery() {
        return `
            SELECT 
                sm.id,
                sm.product_id,
                sm.created_at,
                sm.type,
                sm.quantity,
                sm.comment,
                sm.from_warehouse_id,
                sm.to_warehouse_id,
                sm.created_by,
                sm.wialon_object_id,
                p.sku,
                m.name as model_name,
                wf.name as from_warehouse_name,
                wt.name as to_warehouse_name,
                u.email as created_by_email,
                u.first_name || ' ' || u.last_name as created_by_name,
                jsonb_object_agg(
                    COALESCE(ptc.code, 'none'),
                    jsonb_build_object(
                        'name', ptc.name,
                        'type', ptc.type,
                        'value', pcv.value
                    )
                ) FILTER (WHERE ptc.id IS NOT NULL) as characteristics
            FROM warehouses.stock_movements sm
            JOIN products.products p ON sm.product_id = p.id
            JOIN products.models m ON p.model_id = m.id
            LEFT JOIN warehouses.warehouses wf ON sm.from_warehouse_id = wf.id
            LEFT JOIN warehouses.warehouses wt ON sm.to_warehouse_id = wt.id
            JOIN auth.users u ON sm.created_by = u.id
            LEFT JOIN products.product_type_characteristics ptc ON m.product_type_id = ptc.product_type_id
            LEFT JOIN products.product_characteristic_values pcv ON p.id = pcv.product_id AND ptc.id = pcv.characteristic_id
        `;
    }

    static async getStock(filters) {
        const { 
            page = 1, 
            perPage = 10,
            sortBy = 'created_at',
            descending = true,
            search = '',
            warehouse = '',
            manufacturer = '',
            model = '',
            status = ''
        } = filters;
    
        const sortMapping = {
            'sku': 'p.sku',
            'model_name': 'm.name', 
            'manufacturer_name': 'man.name',
            'warehouse_name': 'w.name',
            'current_status': 'p.current_status',
            'created_at': 's.created_at'
        };
    
        let conditions = ['p.is_active = true'];
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
    
        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const sortByColumn = sortMapping[sortBy] || 's.created_at';
        const orderDirection = descending ? 'DESC' : 'ASC';
    
        const query = `${this.getBaseStockQuery()}
            ${whereClause}
            GROUP BY 
                s.id, 
                s.warehouse_id,
                w.name, 
                s.product_id,
                p.sku, 
                m.name, 
                man.name, 
                p.current_status,
                p.current_object_id,
                s.created_at,
                s.updated_at
            ORDER BY ${sortByColumn} ${orderDirection}, s.id ASC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
        const [stockResult, total] = await Promise.all([
            pool.query(query, [...params, perPage, (page - 1) * perPage]),
            pool.query(`
                SELECT COUNT(DISTINCT s.id)
                FROM warehouses.stock s
                JOIN warehouses.warehouses w ON s.warehouse_id = w.id AND w.is_active = true
                JOIN products.products p ON s.product_id = p.id
                JOIN products.models m ON p.model_id = m.id AND m.is_active = true
                JOIN products.manufacturers man ON m.manufacturer_id = man.id AND m.is_active = true
                ${whereClause}
            `, params)
        ]);
    
        return {
            success: true,
            stock: stockResult.rows,
            total: parseInt(total.rows[0].count)
        };
    }

    static async getStockMovements(filters) {
        const {
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
            createdBy = '',
            product_id = ''
        } = filters;
    
        const sortMapping = {
            'created_at': 'sm.created_at',
            'type': 'sm.type',
            'sku': 'p.sku',
            'model_name': 'm.name',
            'from_warehouse_name': 'wf.name',
            'to_warehouse_name': 'wt.name',
            'created_by_name': 'created_by_name'
        };
    
        let conditions = [];
        let params = [];
        let paramIndex = 1;
    
        if (search) {
            conditions.push(`(
                p.sku ILIKE $${paramIndex} OR 
                m.name ILIKE $${paramIndex} OR
                COALESCE(wf.name, '') ILIKE $${paramIndex} OR
                COALESCE(wt.name, '') ILIKE $${paramIndex} OR
                COALESCE(sm.comment, '') ILIKE $${paramIndex}
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
        const sortByColumn = sortMapping[sortBy] || 'sm.created_at';
        const orderDirection = descending ? 'DESC' : 'ASC';
    
        // Обробка параметра perPage для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const limitClause = limit ? `LIMIT $${paramIndex} OFFSET $${paramIndex + 1}` : '';
        const queryParams = limit 
            ? [...params, limit, (page - 1) * limit] 
            : params;
    
        const query = `${this.getBaseMovementsQuery()}
            ${whereClause}
            GROUP BY 
                sm.id,
                sm.product_id,
                sm.created_at,
                sm.type,
                sm.comment,
                sm.from_warehouse_id,
                sm.to_warehouse_id,
                sm.created_by,
                sm.wialon_object_id,
                p.sku,
                m.name,
                wf.name,
                wt.name,
                u.email,
                u.first_name,
                u.last_name
            ORDER BY ${sortByColumn} ${orderDirection}, sm.id ASC
            ${limitClause}`;
    
        const [movementsResult, total] = await Promise.all([
            pool.query(query, queryParams),
            pool.query(`
                SELECT COUNT(DISTINCT sm.id)
                FROM warehouses.stock_movements sm
                JOIN products.products p ON sm.product_id = p.id
                JOIN products.models m ON p.model_id = m.id
                LEFT JOIN warehouses.warehouses wf ON sm.from_warehouse_id = wf.id
                LEFT JOIN warehouses.warehouses wt ON sm.to_warehouse_id = wt.id
                JOIN auth.users u ON sm.created_by = u.id
                ${whereClause}
            `, params)
        ]);
    
        return {
            success: true,
            movements: movementsResult.rows,
            total: parseInt(total.rows[0].count)
        };
    }

    static async getCurrentLocation(productId) {
        const result = await pool.query(`
            SELECT 
                w.id as warehouse_id,
                w.name as warehouse_name,
                s.quantity,
                s.price
            FROM warehouses.stock s
            JOIN warehouses.warehouses w ON s.warehouse_id = w.id
            WHERE s.product_id = $1 AND s.quantity > 0
            LIMIT 1
        `, [productId]);

        return result.rows[0] || null;
    }

    static async validateTransfer(client, { product_id, from_warehouse_id, to_warehouse_id, quantity }) {
        // Check if warehouses are different
        if (from_warehouse_id === to_warehouse_id) {
            return {
                isValid: false,
                message: 'Cannot transfer to the same warehouse'
            };
        }

        // Check if product exists and is available
        const sourceStock = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [from_warehouse_id, product_id]
        );

        if (sourceStock.rows.length === 0 || sourceStock.rows[0].quantity < quantity) {
            return {
                isValid: false,
                message: 'Insufficient stock in source warehouse'
            };
        }

        return { isValid: true };
    }

    static async transferStock(client, {
        product_id,
        from_warehouse_id,
        to_warehouse_id,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Видаляємо зі старого складу
        await client.query(
            'DELETE FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [from_warehouse_id, product_id]
        );
    
        // Додаємо на новий склад
        await client.query(
            'INSERT INTO warehouses.stock (warehouse_id, product_id) VALUES ($1, $2)',
            [to_warehouse_id, product_id]
        );
    
        // Створюємо запис про рух
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id, from_warehouse_id, to_warehouse_id, 
                quantity, type, comment, created_by
            )
            VALUES ($1, $2, $3, 1, 'transfer', $4, $5)
            RETURNING *`,
            [product_id, from_warehouse_id, to_warehouse_id, comment, userId]
        );
    
        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.STOCK.TRANSFER,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                from_warehouse_id,
                to_warehouse_id,
                comment
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
    
        return movement.rows[0];
    }

    static async validateAdjustment(client, { product_id, warehouse_id, quantity, type }) {
        // Get current stock
        const currentStock = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [warehouse_id, product_id]
        );

        const currentQuantity = currentStock.rows.length > 0 ? currentStock.rows[0].quantity : 0;
        const newQuantity = type === 'increase' ? currentQuantity + quantity : currentQuantity - quantity;

        if (newQuantity < 0) {
            return {
                isValid: false,
                message: 'Cannot reduce stock below zero'
            };
        }

        return { isValid: true };
    }

    static async adjustStock(client, {
        product_id,
        warehouse_id,
        quantity,
        type,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Get current stock
        const currentStock = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [warehouse_id, product_id]
        );

        const currentQuantity = currentStock.rows.length > 0 ? currentStock.rows[0].quantity : 0;
        const newQuantity = type === 'increase' ? currentQuantity + quantity : currentQuantity - quantity;

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
                userId
            ]
        );

        await AuditService.log({
            userId,
            actionType: type === 'increase' ? AUDIT_LOG_TYPES.STOCK.INCREASE : AUDIT_LOG_TYPES.STOCK.DECREASE,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            oldValues: { quantity: currentQuantity },
            newValues: { 
                quantity: newQuantity,
                type,
                comment
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return movement.rows[0];
    }

  
static async validateInstallation(client, { product_id, warehouse_id, object_id }) {
    // Перевірка обов'язкових полів
    if (!product_id || !warehouse_id || !object_id) {
        return {
            isValid: false,
            message: 'Missing required fields'
        };
    }

    // Перевірка чи склад активний
    const warehouse = await client.query(
        'SELECT id FROM warehouses.warehouses WHERE id = $1 AND is_active = true',
        [warehouse_id]
    );

    if (warehouse.rows.length === 0) {
        return {
            isValid: false,
            message: 'Warehouse is not active'
        };
    }

    // Перевірка статусу продукту
    const product = await client.query(
        'SELECT current_status, is_active FROM products.products WHERE id = $1',
        [product_id]
    );

    if (!product.rows[0]?.is_active) {
        return {
            isValid: false,
            message: 'Product is not active'
        };
    }

    if (product.rows[0].current_status !== PRODUCT_STATUS.IN_STOCK) {
        return {
            isValid: false,
            message: 'Product is not available for installation'
        };
    }

    // Перевірка чи є продукт на складі
    const stock = await client.query(
        'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
        [warehouse_id, product_id]
    );

    if (stock.rows.length === 0) {
        return {
            isValid: false,
            message: 'Product not found in warehouse'
        };
    }

    // Перевірка, чи цей продукт вже встановлено на якийсь об'єкт
    const alreadyInstalled = await client.query(
        'SELECT id FROM products.products WHERE id = $1 AND current_status = $2',
        [product_id, PRODUCT_STATUS.INSTALLED]
    );

    if (alreadyInstalled.rows.length > 0) {
        return {
            isValid: false,
            message: 'This product is already installed on another object'
        };
    }

    // Видаляємо перевірку на кількість встановлених продуктів на об'єкт
    // Тепер можна встановлювати декілька продуктів на один об'єкт

    return { isValid: true };
}

    static async installProduct(client, {
        product_id,
        warehouse_id,
        object_id,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Видаляємо зі складу
        await client.query(
            'DELETE FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [warehouse_id, product_id]
        );
    
        // Оновлюємо статус продукту
        await client.query(
            `UPDATE products.products 
             SET current_status = $1,
                 current_object_id = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [PRODUCT_STATUS.INSTALLED, object_id, product_id]
        );
    
        // Створюємо запис про рух
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id,
                from_warehouse_id,
                quantity,
                type,
                wialon_object_id,
                comment,
                created_by
            )
            VALUES ($1, $2, 1, 'install', $3, $4, $5)
            RETURNING *`,
            [product_id, warehouse_id, object_id, comment, userId]
        );
    
        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.STOCK.INSTALL,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                warehouse_id,
                object_id,
                comment
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
    
        return movement.rows[0];
    }

    static async validateUninstallation(client, { product_id, warehouse_id, object_id }) {
        const product = await client.query(
            'SELECT current_status, current_object_id FROM products.products WHERE id = $1',
            [product_id]
        );

        if (product.rows[0].current_status !== PRODUCT_STATUS.INSTALLED ||
            product.rows[0].current_object_id !== object_id) {
            return {
                isValid: false,
                message: 'Product is not installed on this object'
            };
        }

        return { isValid: true };
    }

    static async uninstallProduct(client, {
        product_id,
        warehouse_id,
        object_id,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Додаємо на склад
        await client.query(
            'INSERT INTO warehouses.stock (warehouse_id, product_id) VALUES ($1, $2)',
            [warehouse_id, product_id]
        );
    
        // Оновлюємо статус продукту
        await client.query(
            `UPDATE products.products 
             SET current_status = $1,
                 current_object_id = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [PRODUCT_STATUS.IN_STOCK, product_id]
        );
    
        // Створюємо запис про рух
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id,
                to_warehouse_id,
                quantity,
                type,
                wialon_object_id,
                comment,
                created_by
            )
            VALUES ($1, $2, 1, 'uninstall', $3, $4, $5)
            RETURNING *`,
            [product_id, warehouse_id, object_id, comment, userId]
        );
    
        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.STOCK.UNINSTALL,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                warehouse_id,
                object_id,
                comment
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
    
        return movement.rows[0];
    }

    static async validateRepairSend(client, { product_id, from_warehouse_id }) {
        // Перевірка обов'язкових полів
        if (!product_id) {
            return {
                isValid: false,
                message: 'Product ID is required'
            };
        }

        // Перевірка статусу продукту
        const product = await client.query(
            'SELECT current_status, is_active FROM products.products WHERE id = $1',
            [product_id]
        );

        if (!product.rows[0]?.is_active) {
            return {
                isValid: false,
                message: 'Product is not active'
            };
        }

        if (product.rows[0].current_status === PRODUCT_STATUS.IN_REPAIR) {
            return {
                isValid: false,
                message: 'Product is already in repair'
            };
        }

        if (product.rows[0].current_status === PRODUCT_STATUS.WRITTEN_OFF) {
            return {
                isValid: false,
                message: 'Cannot send written off product to repair'
            };
        }

        // Якщо продукт зі складу, перевіряємо наявність
        if (from_warehouse_id) {
            const warehouse = await client.query(
                'SELECT id FROM warehouses.warehouses WHERE id = $1 AND is_active = true',
                [from_warehouse_id]
            );

            if (warehouse.rows.length === 0) {
                return {
                    isValid: false,
                    message: 'Warehouse is not active'
                };
            }

            const stock = await client.query(
                'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
                [from_warehouse_id, product_id]
            );

            if (stock.rows.length === 0) {
                return {
                    isValid: false,
                    message: 'Product not found in warehouse'
                };
            }
        }

        return { isValid: true };
    }


    static async sendToRepair(client, {
        product_id,
        from_warehouse_id,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Зменшуємо кількість на складі якщо продукт був на складі
        if (from_warehouse_id) {
            await client.query(
                `UPDATE warehouses.stock 
                 SET quantity = quantity - 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE warehouse_id = $1 AND product_id = $2`,
                [from_warehouse_id, product_id]
            );
        }

        // Оновлюємо статус продукту
        await client.query(
            `UPDATE products.products 
             SET current_status = $1,
                 current_object_id = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [PRODUCT_STATUS.IN_REPAIR, product_id]
        );

        // Створюємо запис про рух
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id,
                from_warehouse_id,
                quantity,
                type,
                comment,
                created_by
            )
            VALUES ($1, $2, 1, 'repair_send', $3, $4)
            RETURNING *`,
            [product_id, from_warehouse_id, comment, userId]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.STOCK.REPAIR_SEND,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                from_warehouse_id,
                comment
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return movement.rows[0];
    }

    static async validateRepairReturn(client, { product_id, warehouse_id }) {
        // Перевірка обов'язкових полів
        if (!product_id || !warehouse_id) {
            return {
                isValid: false,
                message: 'Product ID and warehouse ID are required'
            };
        }
    
        const product = await client.query(
            'SELECT current_status FROM products.products WHERE id = $1',
            [product_id]
        );
    
        if (product.rows[0].current_status !== PRODUCT_STATUS.IN_REPAIR) {
            return {
                isValid: false,
                message: 'Product is not in repair'
            };
        }
    
        // Перевірка, що склад існує і активний
        const warehouse = await client.query(
            'SELECT id FROM warehouses.warehouses WHERE id = $1 AND is_active = true',
            [warehouse_id]
        );
    
        if (warehouse.rows.length === 0) {
            return {
                isValid: false,
                message: 'Warehouse not found or not active'
            };
        }
    
        return { isValid: true };
    }

    static async returnFromRepair(client, {
        product_id,
        warehouse_id, // Змінено з to_warehouse_id на warehouse_id
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Додаткова перевірка, що warehouse_id не є null
        if (!warehouse_id) {
            throw new Error('Warehouse ID is required for returning product from repair');
        }
    
        // Додаємо на склад
        await client.query(
            `INSERT INTO warehouses.stock (warehouse_id, product_id, quantity)
             VALUES ($1, $2, 1)
             ON CONFLICT (warehouse_id, product_id) 
             DO UPDATE SET 
                quantity = warehouses.stock.quantity + 1,
                updated_at = CURRENT_TIMESTAMP`,
            [warehouse_id, product_id]
        );
    
        // Оновлюємо статус продукту
        await client.query(
            `UPDATE products.products 
             SET current_status = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [PRODUCT_STATUS.IN_STOCK, product_id]
        );
    
        // Створюємо запис про рух (використовуємо warehouse_id як to_warehouse_id)
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id,
                to_warehouse_id,
                quantity,
                type,
                comment,
                created_by
            )
            VALUES ($1, $2, 1, 'repair_return', $3, $4)
            RETURNING *`,
            [product_id, warehouse_id, comment, userId]
        );
    
        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.STOCK.REPAIR_RETURN,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                to_warehouse_id: warehouse_id, // Використовуємо warehouse_id для логування
                comment
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
    
        return movement.rows[0];
    }

    static async validateWriteOff(client, { product_id, warehouse_id, comment }) {
        // Перевірка обов'язкових полів
        if (!product_id || !warehouse_id || !comment) {
            return {
                isValid: false,
                message: 'Missing required fields (product, warehouse or comment)'
            };
        }

        // Перевірка чи склад активний
        const warehouse = await client.query(
            'SELECT id FROM warehouses.warehouses WHERE id = $1 AND is_active = true',
            [warehouse_id]
        );

        if (warehouse.rows.length === 0) {
            return {
                isValid: false,
                message: 'Warehouse is not active'
            };
        }

        // Перевірка статусу продукту
        const product = await client.query(
            'SELECT current_status, is_active FROM products.products WHERE id = $1',
            [product_id]
        );

        if (!product.rows[0]?.is_active) {
            return {
                isValid: false,
                message: 'Product is not active'
            };
        }

        if (product.rows[0].current_status === PRODUCT_STATUS.WRITTEN_OFF) {
            return {
                isValid: false,
                message: 'Product is already written off'
            };
        }

        // Перевірка наявності на складі
        const stock = await client.query(
            'SELECT quantity FROM warehouses.stock WHERE warehouse_id = $1 AND product_id = $2',
            [warehouse_id, product_id]
        );

        if (stock.rows.length === 0) {
            return {
                isValid: false,
                message: 'Product not found in warehouse'
            };
        }

        return { isValid: true };
    }


    static async writeOffProduct(client, {
        product_id,
        warehouse_id,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Зменшуємо кількість на складі
        await client.query(
            `UPDATE warehouses.stock 
             SET quantity = quantity - 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE warehouse_id = $1 AND product_id = $2`,
            [warehouse_id, product_id]
        );

        // Оновлюємо статус продукту
        await client.query(
            `UPDATE products.products 
             SET current_status = $1,
                 current_object_id = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [PRODUCT_STATUS.WRITTEN_OFF, product_id]
        );

        // Створюємо запис про рух
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id,
                from_warehouse_id,
                quantity,
                type,
                comment,
                created_by
            )
            VALUES ($1, $2, 1, 'write_off', $3, $4)
            RETURNING *`,
            [product_id, warehouse_id, comment, userId]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.STOCK.WRITE_OFF,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                warehouse_id,
                comment
            },
            ipAddress,
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return movement.rows[0];
    }
    static async getStockMetrics() {
        try {
            // Отримання загальної кількості одиниць (враховуємо лише активні товари)
            const totalItemsQuery = `
                SELECT COALESCE(SUM(s.quantity), 0) as total_items
                FROM warehouses.stock s
                JOIN products.products p ON s.product_id = p.id
                WHERE p.is_active = true
            `;
            
            // Отримання загальної кількості товарів (різних найменувань)
            const totalProductsQuery = `
                SELECT COUNT(DISTINCT s.product_id) as total_products
                FROM warehouses.stock s
                JOIN products.products p ON s.product_id = p.id
                WHERE s.quantity > 0 AND p.is_active = true
            `;
            
            // Отримання кількості з малим залишком (<5)
            const lowStockQuery = `
                SELECT COUNT(*) as low_stock_count
                FROM warehouses.stock s
                JOIN products.products p ON s.product_id = p.id
                WHERE s.quantity > 0 AND s.quantity < 5 AND p.is_active = true
            `;
            
            // Отримання кількості з середнім залишком (5-10)
            const mediumStockQuery = `
                SELECT COUNT(*) as medium_stock_count
                FROM warehouses.stock s
                JOIN products.products p ON s.product_id = p.id
                WHERE s.quantity >= 5 AND s.quantity <= 10 AND p.is_active = true
            `;
            
            // Отримання кількості активних складів
            const warehousesQuery = `
                SELECT COUNT(*) as warehouses_count
                FROM warehouses.warehouses
                WHERE is_active = true
            `;
            
            // Виконання всіх запитів паралельно
            const [totalItems, totalProducts, lowStock, mediumStock, warehouses] = await Promise.all([
                pool.query(totalItemsQuery),
                pool.query(totalProductsQuery),
                pool.query(lowStockQuery),
                pool.query(mediumStockQuery),
                pool.query(warehousesQuery)
            ]);
            
            return {
                totalItems: parseInt(totalItems.rows[0].total_items) || 0,
                totalProducts: parseInt(totalProducts.rows[0].total_products) || 0,
                lowStockCount: parseInt(lowStock.rows[0].low_stock_count) || 0,
                mediumStockCount: parseInt(mediumStock.rows[0].medium_stock_count) || 0,
                warehousesCount: parseInt(warehouses.rows[0].warehouses_count) || 0
            };
        } catch (error) {
            console.error('Error getting stock metrics:', error);
            throw error;
        }
    }
    static async getStockByWarehouse() {
        try {
            const query = `
                SELECT 
                    w.id as warehouse_id,
                    w.name as warehouse_name,
                    COUNT(CASE WHEN s.quantity < 5 AND s.quantity > 0 THEN 1 END) as low_stock_count,
                    COUNT(CASE WHEN s.quantity >= 5 AND s.quantity <= 10 THEN 1 END) as medium_stock_count,
                    COUNT(CASE WHEN s.quantity > 10 THEN 1 END) as high_stock_count,
                    COALESCE(SUM(s.quantity), 0) as total_quantity
                FROM warehouses.warehouses w
                LEFT JOIN warehouses.stock s ON w.id = s.warehouse_id
                LEFT JOIN products.products p ON s.product_id = p.id
                WHERE w.is_active = true AND (p.is_active = true OR p.id IS NULL)
                GROUP BY w.id, w.name
                ORDER BY w.name
            `;
            
            const result = await pool.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error getting stock by warehouse:', error);
            throw error;
        }
    }
    static async getStockByType() {
        try {
            const query = `
                SELECT 
                    pt.id as product_type_id,
                    pt.name as product_type_name,
                    COUNT(DISTINCT s.product_id) as product_count,
                    COALESCE(SUM(s.quantity), 0) as quantity
                FROM products.product_types pt
                JOIN products.models m ON pt.id = m.product_type_id
                JOIN products.products p ON m.id = p.model_id
                JOIN warehouses.stock s ON p.id = s.product_id
                WHERE pt.is_active = true AND p.is_active = true AND s.quantity > 0
                GROUP BY pt.id, pt.name
                ORDER BY quantity DESC
            `;
            
            const result = await pool.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error getting stock by type:', error);
            throw error;
        }
    }
    
    static async getCriticalStock(limit = 50) {
        try {
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
                WHERE s.quantity > 0 AND s.quantity <= 10 AND p.is_active = true AND w.is_active = true
                ORDER BY s.quantity ASC
                LIMIT $1
            `;
            
            const result = await pool.query(query, [limit]);
            return result.rows;
        } catch (error) {
            console.error('Error getting critical stock:', error);
            throw error;
        }
    }
    static async getStockByModel(limit = 20) {
        try {
            const query = `
                SELECT 
                    m.id as model_id,
                    m.name as model_name,
                    pt.name as product_type_name,
                    man.name as manufacturer_name,
                    COUNT(DISTINCT s.product_id) as product_count,
                    COALESCE(SUM(s.quantity), 0) as quantity
                FROM products.models m
                JOIN products.product_types pt ON m.product_type_id = pt.id
                JOIN products.manufacturers man ON m.manufacturer_id = man.id
                JOIN products.products p ON m.id = p.model_id
                JOIN warehouses.stock s ON p.id = s.product_id
                WHERE m.is_active = true AND p.is_active = true AND s.quantity > 0
                GROUP BY m.id, m.name, pt.name, man.name
                ORDER BY quantity DESC
                LIMIT $1
            `;
            
            const result = await pool.query(query, [limit]);
            return result.rows;
        } catch (error) {
            console.error('Error getting stock by model:', error);
            throw error;
        }
    }


// Отримання загальної інформації по складу
    static async getWarehouseStockSummary(warehouseId = null) {
        try {
            let warehouseCondition = '';
            let params = [];
            let paramIndex = 1;

            if (warehouseId) {
                warehouseCondition = 'AND s.warehouse_id = $1';
                params.push(warehouseId);
                paramIndex = 2;
            }

            const query = `
                SELECT 
                    COUNT(DISTINCT s.product_id) as total_products,
                    COALESCE(SUM(s.quantity), 0) as total_quantity,
                    COUNT(DISTINCT m.product_type_id) as product_types_count,
                    COUNT(CASE WHEN s.quantity < 5 THEN 1 END) as critical_count
                FROM warehouses.stock s
                JOIN products.products p ON s.product_id = p.id
                JOIN products.models m ON p.model_id = m.id
                WHERE p.is_active = true ${warehouseCondition}
            `;
            
            const result = await pool.query(query, params);
            return result.rows[0];
        } catch (error) {
            console.error('Error getting warehouse stock summary:', error);
            throw error;
        }
    }

    // Розподіл по типах товарів для складу
    static async getStockByTypesForWarehouse(warehouseId = null) {
        try {
            let warehouseCondition = '';
            let params = [];

            if (warehouseId) {
                warehouseCondition = 'AND s.warehouse_id = $1';
                params.push(warehouseId);
            }

            const query = `
                SELECT 
                    pt.id as product_type_id,
                    pt.name as product_type_name,
                    COUNT(DISTINCT s.product_id) as product_count,
                    COALESCE(SUM(s.quantity), 0) as total_quantity
                FROM products.product_types pt
                JOIN products.models m ON pt.id = m.product_type_id
                JOIN products.products p ON m.id = p.model_id
                JOIN warehouses.stock s ON p.id = s.product_id
                WHERE pt.is_active = true AND p.is_active = true ${warehouseCondition}
                GROUP BY pt.id, pt.name
                ORDER BY total_quantity DESC
            `;
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error getting stock by types:', error);
            throw error;
        }
    }

    // Моделі з залишками для складу
    static async getModelStockForWarehouse(warehouseId = null, filters = {}) {
        try {
            const {
                search = '',
                productType = '',
                sortBy = 'quantity',
                descending = true
            } = filters;

            let conditions = ['p.is_active = true'];
            let params = [];
            let paramIndex = 1;

            if (warehouseId) {
                conditions.push(`s.warehouse_id = $${paramIndex}`);
                params.push(warehouseId);
                paramIndex++;
            }

            if (search) {
                conditions.push(`(
                    m.name ILIKE $${paramIndex} OR 
                    man.name ILIKE $${paramIndex} OR
                    pt.name ILIKE $${paramIndex}
                )`);
                params.push(`%${search}%`);
                paramIndex++;
            }

            if (productType) {
                conditions.push(`pt.id = $${paramIndex}`);
                params.push(productType);
                paramIndex++;
            }

            const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
            
            const sortMapping = {
                'model_name': 'm.name',
                'manufacturer_name': 'man.name',
                'product_type_name': 'pt.name',
                'quantity': 'total_quantity'
            };

            const sortByColumn = sortMapping[sortBy] || 'total_quantity';
            const orderDirection = descending ? 'DESC' : 'ASC';

            const query = `
                SELECT 
                    m.id as model_id,
                    m.name as model_name,
                    man.name as manufacturer_name,
                    pt.name as product_type_name,
                    pt.id as product_type_id,
                    COALESCE(SUM(s.quantity), 0) as total_quantity,
                    COUNT(DISTINCT s.product_id) as product_count,
                    CASE 
                        WHEN COALESCE(SUM(s.quantity), 0) >= 10 THEN 'high'
                        WHEN COALESCE(SUM(s.quantity), 0) >= 5 THEN 'medium'
                        ELSE 'critical'
                    END as stock_status
                FROM products.models m
                JOIN products.manufacturers man ON m.manufacturer_id = man.id
                JOIN products.product_types pt ON m.product_type_id = pt.id
                JOIN products.products p ON m.id = p.model_id
                LEFT JOIN warehouses.stock s ON p.id = s.product_id
                ${whereClause}
                GROUP BY m.id, m.name, man.name, pt.name, pt.id
                ORDER BY ${sortByColumn} ${orderDirection}
            `;
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error getting model stock:', error);
            throw error;
        }
    }

    // Товари в ремонті з тривалістю
    static async getRepairItems(filters = {}) {
        try {
            const {
                search = '',
                sortBy = 'days_in_repair',
                descending = true
            } = filters;

            let conditions = ["p.current_status = 'in_repair'", 'p.is_active = true'];
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

            const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
            
            const sortMapping = {
                'sku': 'p.sku',
                'model_name': 'm.name',
                'manufacturer_name': 'man.name',
                'sent_date': 'repair_sent_date',
                'days_in_repair': 'days_in_repair'
            };

            const sortByColumn = sortMapping[sortBy] || 'days_in_repair';
            const orderDirection = descending ? 'DESC' : 'ASC';

            const query = `
                SELECT 
                    p.id as product_id,
                    p.sku,
                    m.name as model_name,
                    man.name as manufacturer_name,
                    pt.name as product_type_name,
                    sm.created_at as repair_sent_date,
                    EXTRACT(DAY FROM (CURRENT_TIMESTAMP - sm.created_at))::integer as days_in_repair,
                    wf.name as from_warehouse_name,
                    sm.comment
                FROM products.products p
                JOIN products.models m ON p.model_id = m.id
                JOIN products.manufacturers man ON m.manufacturer_id = man.id
                JOIN products.product_types pt ON m.product_type_id = pt.id
                LEFT JOIN warehouses.stock_movements sm ON p.id = sm.product_id 
                    AND sm.type = 'repair_send'
                    AND sm.id = (
                        SELECT MAX(id) FROM warehouses.stock_movements 
                        WHERE product_id = p.id AND type = 'repair_send'
                    )
                LEFT JOIN warehouses.warehouses wf ON sm.from_warehouse_id = wf.id
                ${whereClause}
                ORDER BY ${sortByColumn} ${orderDirection}
            `;
            
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error getting repair items:', error);
            throw error;
        }
    }
}



module.exports = StockService;