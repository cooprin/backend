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
                p.warranty_end,
                p.supplier_warranty_end,
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
            LEFT JOIN products.product_type_characteristics ptc ON p.product_type_id = ptc.product_type_id
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
            LEFT JOIN products.product_type_characteristics ptc ON p.product_type_id = ptc.product_type_id
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
            status = '',
            characteristic = ''
        } = filters;

        const sortMapping = {
            'sku': 'p.sku',
            'model_name': 'm.name', 
            'manufacturer_name': 'man.name',
            'warehouse_name': 'w.name',
            'current_status': 'p.current_status',
            'created_at': 's.created_at'
        };

        let conditions = ['p.is_active = true']; // Завжди фільтруємо по активним
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

        if (characteristic) {
            const [charCode, charValue] = characteristic.split(':');
            if (charCode && charValue) {
                conditions.push(`(
                    EXISTS (
                        SELECT 1 FROM products.product_characteristic_values pcv2
                        JOIN products.product_type_characteristics ptc2 ON pcv2.characteristic_id = ptc2.id
                        WHERE pcv2.product_id = p.id 
                        AND ptc2.code = $${paramIndex}
                        AND pcv2.value = $${paramIndex + 1}
                    )
                )`);
                params.push(charCode, charValue);
                paramIndex += 2;
            }
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');
        const sortByColumn = sortMapping[sortBy] || 's.created_at';
        const orderDirection = descending ? 'DESC' : 'ASC';

        const query = `${this.getBaseStockQuery()}
            ${whereClause}
            GROUP BY s.id, w.name, p.sku, m.name, man.name, p.current_status, p.current_object_id, p.warranty_end
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
                JOIN products.manufacturers man ON m.manufacturer_id = man.id AND man.is_active = true
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
            'quantity': 'sm.quantity',
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

        const query = `${this.getBaseMovementsQuery()}
        ${whereClause}
        GROUP BY 
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
            m.name,
            wf.name,
            wt.name,
            u.email,
            u.first_name,
            u.last_name
        ORDER BY ${sortByColumn} ${orderDirection}, sm.id ASC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

        const [movementsResult, total] = await Promise.all([
            pool.query(query, [...params, perPage, (page - 1) * perPage]),
            pool.query(`
                SELECT COUNT(DISTINCT sm.id)
                FROM warehouses.stock_movements sm
                JOIN products.products p ON sm.product_id = p.id
                JOIN products.models m ON p.model_id = m.id
                LEFT JOIN warehouses.warehouses wf ON sm.from_warehouse_id = wf.id
                LEFT JOIN warehouses.warehouses wt ON sm.to_warehouse_id = wt.id
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
        quantity,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Update source stock
        await client.query(
            `UPDATE warehouses.stock 
             SET quantity = quantity - $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE warehouse_id = $2 AND product_id = $3`,
            [quantity, from_warehouse_id, product_id]
        );

        // Update or create destination stock
        await client.query(
            `INSERT INTO warehouses.stock (warehouse_id, product_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, product_id) 
             DO UPDATE SET 
                quantity = warehouses.stock.quantity + EXCLUDED.quantity,
                updated_at = CURRENT_TIMESTAMP`,
            [to_warehouse_id, product_id, quantity]
        );

        // Create movement record
        const movement = await client.query(
            `INSERT INTO warehouses.stock_movements (
                product_id, from_warehouse_id, to_warehouse_id, 
                quantity, type, comment, created_by
            )
            VALUES ($1, $2, $3, $4, 'transfer', $5, $6)
            RETURNING *`,
            [product_id, from_warehouse_id, to_warehouse_id, quantity, comment, userId]
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
                quantity,
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

        // Перевірка чи не встановлено вже інший продукт на цей об'єкт
        const installedProduct = await client.query(
            'SELECT id FROM products.products WHERE current_object_id = $1 AND current_status = $2',
            [object_id, PRODUCT_STATUS.INSTALLED]
        );

        if (installedProduct.rows.length > 0) {
            return {
                isValid: false,
                message: 'Another product is already installed on this object'
            };
        }

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
            VALUES ($1, $2, $3, 'install', $4, $5, $6)
            RETURNING *`,
            [product_id, warehouse_id, 1, object_id, comment, userId]
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
            VALUES ($1, $2, $3, 'uninstall', $4, $5, $6)
            RETURNING *`,
            [product_id, warehouse_id, 1, object_id, comment, userId]
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

    static async validateRepairReturn(client, { product_id, to_warehouse_id }) {
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

        return { isValid: true };
    }

    static async returnFromRepair(client, {
        product_id,
        to_warehouse_id,
        comment = null,
        userId,
        ipAddress,
        req
    }) {
        // Додаємо на склад
        await client.query(
            `INSERT INTO warehouses.stock (warehouse_id, product_id, quantity)
             VALUES ($1, $2, 1)
             ON CONFLICT (warehouse_id, product_id) 
             DO UPDATE SET 
                quantity = warehouses.stock.quantity + 1,
                updated_at = CURRENT_TIMESTAMP`,
            [to_warehouse_id, product_id]
        );

        // Оновлюємо статус продукту
        await client.query(
            `UPDATE products.products 
             SET current_status = $1,
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
                comment,
                created_by
            )
            VALUES ($1, $2, 1, 'repair_return', $3, $4)
            RETURNING *`,
            [product_id, to_warehouse_id, comment, userId]
        );

        await AuditService.log({
            userId,
            actionType: AUDIT_LOG_TYPES.STOCK.REPAIR_RETURN,
            entityType: ENTITY_TYPES.STOCK,
            entityId: movement.rows[0].id,
            newValues: { 
                product_id,
                to_warehouse_id,
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
}

module.exports = StockService;