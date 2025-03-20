const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

class WialonService {
    // Отримання списку об'єктів з фільтрацією та пагінацією
    static async getObjects(filters) {
        const {
            page = 1,
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            client_id = null,
            status = null
        } = filters;

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                o.name ILIKE $${paramIndex} OR
                o.wialon_id ILIKE $${paramIndex} OR
                c.name ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (client_id) {
            conditions.push(`o.client_id = $${paramIndex}`);
            params.push(client_id);
            paramIndex++;
        }

        if (status) {
            conditions.push(`o.status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
        
        // Визначення поля для сортування
        let orderByField;
        switch(sortBy) {
            case 'name':
                orderByField = 'o.name';
                break;
            case 'wialon_id':
                orderByField = 'o.wialon_id';
                break;
            case 'client_name':
                orderByField = 'c.name';
                break;
            case 'status':
                orderByField = 'o.status';
                break;
            case 'created_at':
                orderByField = 'o.created_at';
                break;
            default:
                orderByField = 'o.name';
        }

        // Обробка опції "всі записи" для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        let query = `
            SELECT 
                o.*,
                c.name as client_name,
                c.wialon_username as client_wialon_username,
                t.id as tariff_id,
                t.name as tariff_name,
                t.price as tariff_price,
                COUNT(p.id) as products_count
            FROM wialon.objects o
            JOIN clients.clients c ON o.client_id = c.id
            LEFT JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
            LEFT JOIN billing.tariffs t ON ot.tariff_id = t.id
            LEFT JOIN products.products p ON p.current_object_id = o.id AND p.current_status = 'installed'
            ${whereClause}
            GROUP BY o.id, c.name, c.wialon_username, t.id, t.name, t.price
            ORDER BY ${orderByField} ${orderDirection}
        `;

        if (limit !== null) {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
        }

        const countQuery = `
            SELECT COUNT(*) FROM wialon.objects o
            JOIN clients.clients c ON o.client_id = c.id
            ${whereClause}
        `;

        const [objectsResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
        ]);

        return {
            objects: objectsResult.rows,
            total: parseInt(countResult.rows[0].count)
        };
    }

    // Отримання об'єкта за ID з детальною інформацією
    static async getObjectById(id) {
        const objectQuery = `
            SELECT 
                o.*,
                c.name as client_name,
                c.wialon_username as client_wialon_username,
                t.id as tariff_id,
                t.name as tariff_name,
                t.price as tariff_price,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', p.id,
                        'sku', p.sku,
                        'model_name', m.name,
                        'manufacturer_name', man.name,
                        'current_status', p.current_status
                    )
                ) FILTER (WHERE p.id IS NOT NULL) as installed_products,
                json_agg(
                    DISTINCT jsonb_build_object(
                        'id', ooh.id,
                        'client_id', prev_c.id,
                        'client_name', prev_c.name,
                        'start_date', ooh.start_date,
                        'end_date', ooh.end_date,
                        'notes', ooh.notes
                    )
                ) FILTER (WHERE ooh.id IS NOT NULL) as ownership_history
            FROM wialon.objects o
            JOIN clients.clients c ON o.client_id = c.id
            LEFT JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
            LEFT JOIN billing.tariffs t ON ot.tariff_id = t.id
            LEFT JOIN products.products p ON p.current_object_id = o.id AND p.current_status = 'installed'
            LEFT JOIN products.models m ON p.model_id = m.id
            LEFT JOIN products.manufacturers man ON m.manufacturer_id = man.id
            LEFT JOIN wialon.object_ownership_history ooh ON o.id = ooh.object_id
            LEFT JOIN clients.clients prev_c ON ooh.client_id = prev_c.id
            WHERE o.id = $1
            GROUP BY o.id, c.name, c.wialon_username, t.id, t.name, t.price
        `;

        const result = await pool.query(objectQuery, [id]);
        
        if (result.rows.length === 0) {
            return null;
        }

        // Отримуємо історію тарифів окремим запитом
        const tariffsQuery = `
            SELECT 
                ot.*,
                t.name as tariff_name,
                t.price
            FROM billing.object_tariffs ot
            JOIN billing.tariffs t ON ot.tariff_id = t.id
            WHERE ot.object_id = $1
            ORDER BY ot.effective_from DESC
        `;

        const tariffsResult = await pool.query(tariffsQuery, [id]);
        
        const object = result.rows[0];
        object.tariff_history = tariffsResult.rows;
        
        return object;
    }

    // Створення нового об'єкта
    static async createObject(client, data, userId, req) {
        try {
            const { 
                name, wialon_id, description, client_id, status,
                tariff_id, tariff_effective_from, attributes, operation_date
            } = data;

            // Перевірка наявності об'єкта з таким Wialon ID
            const existingObject = await client.query(
                'SELECT id FROM wialon.objects WHERE wialon_id = $1',
                [wialon_id]
            );

            if (existingObject.rows.length > 0) {
                throw new Error('Об\'єкт з таким Wialon ID вже існує');
            }

            // Перевірка наявності клієнта
            const clientExists = await client.query(
                'SELECT id FROM clients.clients WHERE id = $1',
                [client_id]
            );

            if (clientExists.rows.length === 0) {
                throw new Error('Вказаний клієнт не існує');
            }

            // Використовуємо вказану дату операції або поточну дату
            const effectiveDate = operation_date ? new Date(operation_date) : new Date();

            // Створення об'єкта
            const result = await client.query(
                `INSERT INTO wialon.objects (
                    name, wialon_id, description, client_id, status, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *`,
                [
                    name, 
                    wialon_id, 
                    description, 
                    client_id, 
                    status || 'active',
                    effectiveDate
                ]
            );

            const newObject = result.rows[0];

            // Додавання запису в історію власників з вказаною датою
            await client.query(
                `INSERT INTO wialon.object_ownership_history (
                    object_id, client_id, start_date, created_by, created_at
                )
                VALUES ($1, $2, $3, $4, $5)`,
                [newObject.id, client_id, effectiveDate, userId, effectiveDate]
            );

            // Додавання тарифу, якщо він вказаний
            if (tariff_id) {
                const tariffDate = tariff_effective_from ? new Date(tariff_effective_from) : effectiveDate;
                
                await client.query(
                    `INSERT INTO billing.object_tariffs (
                        object_id, tariff_id, effective_from, created_by
                    )
                    VALUES ($1, $2, $3, $4)`,
                    [
                        newObject.id, 
                        tariff_id, 
                        tariffDate, 
                        userId
                    ]
                );
            }

            // Додавання атрибутів, якщо вони є
            if (attributes && typeof attributes === 'object') {
                for (const [key, value] of Object.entries(attributes)) {
                    await client.query(
                        `INSERT INTO wialon.object_attributes (
                            object_id, attribute_name, attribute_value
                        )
                        VALUES ($1, $2, $3)`,
                        [newObject.id, key, value]
                    );
                }
            }

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'OBJECT_CREATE',
                entityType: 'WIALON_OBJECT',
                entityId: newObject.id,
                newValues: {...data, operation_date: effectiveDate},
                ipAddress: req.ip,
                tableSchema: 'wialon',
                tableName: 'objects',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return newObject;
        } catch (error) {
            throw error;
        }
    }

    // Оновлення існуючого об'єкта
    static async updateObject(client, id, data, userId, req) {
        try {
            // Отримання поточних даних об'єкта для аудиту
            const currentObject = await client.query(
                'SELECT * FROM wialon.objects WHERE id = $1',
                [id]
            );

            if (currentObject.rows.length === 0) {
                throw new Error('Об\'єкт не знайдений');
            }

            const oldData = currentObject.rows[0];

            // Перевірка унікальності Wialon ID
            if (data.wialon_id && data.wialon_id !== oldData.wialon_id) {
                const existingObject = await client.query(
                    'SELECT id FROM wialon.objects WHERE wialon_id = $1 AND id != $2',
                    [data.wialon_id, id]
                );

                if (existingObject.rows.length > 0) {
                    throw new Error('Об\'єкт з таким Wialon ID вже існує');
                }
            }

            // Використовуємо вказану дату операції або поточну дату
            const effectiveDate = data.operation_date ? new Date(data.operation_date) : new Date();

            // Якщо змінюється клієнт, додаємо запис в історію власників
            if (data.client_id && data.client_id !== oldData.client_id) {
                // Закриваємо попередній запис
                await client.query(
                    `UPDATE wialon.object_ownership_history 
                     SET end_date = $1
                     WHERE object_id = $2 AND end_date IS NULL`,
                    [effectiveDate, id]
                );

                // Додаємо новий запис
                await client.query(
                    `INSERT INTO wialon.object_ownership_history (
                        object_id, client_id, start_date, created_by
                    )
                    VALUES ($1, $2, $3, $4)`,
                    [id, data.client_id, effectiveDate, userId]
                );
            }

            // Підготовка оновлених даних
            const updateFields = [];
            const updateValues = [];
            let paramIndex = 1;

            const fieldsToUpdate = [
                'name', 'wialon_id', 'description', 'client_id', 'status'
            ];

            for (const field of fieldsToUpdate) {
                if (data[field] !== undefined) {
                    updateFields.push(`${field} = $${paramIndex++}`);
                    updateValues.push(data[field]);
                }
            }

            updateFields.push(`updated_at = $${paramIndex++}`);
            updateValues.push(effectiveDate);
            updateValues.push(id);

            // Оновлення об'єкта
            const result = await client.query(
                `UPDATE wialon.objects 
                 SET ${updateFields.join(', ')}
                 WHERE id = $${paramIndex}
                 RETURNING *`,
                updateValues
            );

            // Оновлення тарифу, якщо вказано
            if (data.tariff_id) {
                // Використовуємо вказану дату для тарифу або дату операції
                const tariffDate = data.tariff_effective_from ? 
                    new Date(data.tariff_effective_from) : effectiveDate;

                // Перевіряємо чи є вже активний тариф
                const currentTariff = await client.query(
                    `SELECT id FROM billing.object_tariffs 
                     WHERE object_id = $1 AND effective_to IS NULL`,
                    [id]
                );

                // Якщо є активний тариф, закриваємо його
                if (currentTariff.rows.length > 0) {
                    await client.query(
                        `UPDATE billing.object_tariffs 
                         SET effective_to = $1
                         WHERE id = $2`,
                        [tariffDate, currentTariff.rows[0].id]
                    );
                }

                // Додаємо новий тариф
                await client.query(
                    `INSERT INTO billing.object_tariffs (
                        object_id, tariff_id, effective_from, created_by
                    )
                    VALUES ($1, $2, $3, $4)`,
                    [
                        id, 
                        data.tariff_id, 
                        tariffDate, 
                        userId
                    ]
                );
            }

            // Оновлення атрибутів, якщо вказано
            if (data.attributes && typeof data.attributes === 'object') {
                // Видалення всіх атрибутів
                await client.query(
                    'DELETE FROM wialon.object_attributes WHERE object_id = $1',
                    [id]
                );

                // Додавання нових атрибутів
                for (const [key, value] of Object.entries(data.attributes)) {
                    await client.query(
                        `INSERT INTO wialon.object_attributes (
                            object_id, attribute_name, attribute_value
                        )
                        VALUES ($1, $2, $3)`,
                        [id, key, value]
                    );
                }
            }

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'OBJECT_UPDATE',
                entityType: 'WIALON_OBJECT',
                entityId: id,
                oldValues: oldData,
                newValues: {...data, operation_date: effectiveDate},
                ipAddress: req.ip,
                tableSchema: 'wialon',
                tableName: 'objects',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Зміна власника об'єкта
static async changeOwner(client, id, data, userId, req) {
    try {
        const { client_id, notes, operation_date } = data;

        if (!client_id) {
            throw new Error('ID клієнта обов\'язковий');
        }

        // Перевірка наявності об'єкта
        const object = await client.query(
            'SELECT * FROM wialon.objects WHERE id = $1',
            [id]
        );

        if (object.rows.length === 0) {
            throw new Error('Об\'єкт не знайдений');
        }

        const objectData = object.rows[0];

        // Перевірка наявності клієнта
        const clientExists = await client.query(
            'SELECT id FROM clients.clients WHERE id = $1',
            [client_id]
        );

        if (clientExists.rows.length === 0) {
            throw new Error('Вказаний клієнт не існує');
        }

        // Якщо власник не змінюється, немає потреби в оновленні
        if (objectData.client_id === client_id) {
            throw new Error('Вказаний клієнт вже є власником об\'єкта');
        }
        
        // Використовуємо вказану дату операції або поточну дату
        const effectiveDate = operation_date ? new Date(operation_date) : new Date();
        const dayOfMonth = effectiveDate.getDate();
        const currentMonth = effectiveDate.getMonth() + 1;
        const currentYear = effectiveDate.getFullYear();

        // Перевіряємо, чи поточний період вже оплачений для поточного власника
        const isPeriodPaidResult = await client.query(
            'SELECT billing.is_period_paid($1, $2, $3) as is_paid',
            [id, currentYear, currentMonth]
        );
        
        const isPeriodPaid = isPeriodPaidResult.rows[0].is_paid;
        
        // Закриваємо попередній запис в історії власників
        await client.query(
            `UPDATE wialon.object_ownership_history 
            SET end_date = $1
            WHERE object_id = $2 AND end_date IS NULL`,
            [effectiveDate, id]
        );

        // Додаємо новий запис в історію власників
        await client.query(
            `INSERT INTO wialon.object_ownership_history (
                object_id, client_id, start_date, notes, created_by
            )
            VALUES ($1, $2, $3, $4, $5)`,
            [id, client_id, effectiveDate, notes, userId]
        );

        // Оновлюємо власника об'єкта
        const result = await client.query(
            `UPDATE wialon.objects 
            SET client_id = $1, updated_at = $2
            WHERE id = $3
            RETURNING *`,
            [client_id, effectiveDate, id]
        );
        
        // Якщо об'єкт переданий до 15-го числа і період не оплачений,
        // додаємо запис в атрибути об'єкта про необхідність оплати
        if (dayOfMonth <= 15 && !isPeriodPaid) {
            // Отримуємо активний тариф для об'єкта
            const tariffResult = await client.query(
                `SELECT t.id, t.price
                FROM billing.object_tariffs ot
                JOIN billing.tariffs t ON ot.tariff_id = t.id
                WHERE ot.object_id = $1 AND ot.effective_to IS NULL`,
                [id]
            );
            
            if (tariffResult.rows.length > 0) {
                const tariffId = tariffResult.rows[0].id;
                
                // Додаємо запис в атрибути об'єкта про необхідність оплати
                await client.query(
                    `INSERT INTO wialon.object_attributes (
                        object_id, attribute_name, attribute_value
                    )
                    VALUES ($1, $2, $3)
                    ON CONFLICT (object_id, attribute_name) 
                    DO UPDATE SET attribute_value = $3`,
                    [
                        id, 
                        'payment_required_month', 
                        `${currentMonth}-${currentYear}`
                    ]
                );
            }
        }

        // Автоматично призначаємо послуги типу object_based новому клієнту, якщо вони ще не призначені
        await client.query(
            `INSERT INTO services.client_services (client_id, service_id, start_date, status, notes)
            SELECT $1, s.id, $2, 'active', 'Автоматично призначено при зміні власника об''єкта ' || $3
            FROM services.services s
            WHERE s.service_type = 'object_based' AND s.is_active = true
            AND NOT EXISTS (
                SELECT 1 FROM services.client_services cs
                WHERE cs.client_id = $1 AND cs.service_id = s.id
                AND (cs.end_date IS NULL OR cs.end_date >= $2)
                AND cs.status = 'active'
            )`,
            [client_id, effectiveDate, result.rows[0].name]
        );

        // Аудит
        await AuditService.log({
            userId,
            actionType: 'OBJECT_CHANGE_OWNER',
            entityType: 'WIALON_OBJECT',
            entityId: id,
            oldValues: { client_id: objectData.client_id },
            newValues: { client_id, notes, operation_date: effectiveDate },
            ipAddress: req.ip,
            tableSchema: 'wialon',
            tableName: 'objects',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return result.rows[0];
    } catch (error) {
        throw error;
    }
}

    // Видалення об'єкта
    static async deleteObject(client, id, userId, req) {
        try {
            // Перевірка чи є встановлені продукти
            const productsCheck = await client.query(
                'SELECT id FROM products.products WHERE current_object_id = $1 AND current_status = $2',
                [id, 'installed']
            );

            if (productsCheck.rows.length > 0) {
                throw new Error('Неможливо видалити об\'єкт, на якому встановлено продукти');
            }

            // Отримання даних об'єкта для аудиту
            const objectData = await client.query(
                'SELECT * FROM wialon.objects WHERE id = $1',
                [id]
            );

            if (objectData.rows.length === 0) {
                throw new Error('Об\'єкт не знайдений');
            }

            // Видалення атрибутів об'єкта
            await client.query(
                'DELETE FROM wialon.object_attributes WHERE object_id = $1',
                [id]
            );

            // Видалення історії власників
            await client.query(
                'DELETE FROM wialon.object_ownership_history WHERE object_id = $1',
                [id]
            );

            // Видалення історії тарифів
            await client.query(
                'DELETE FROM billing.object_tariffs WHERE object_id = $1',
                [id]
            );

            // Видалення записів оплат
            await client.query(
                'DELETE FROM billing.object_payment_records WHERE object_id = $1',
                [id]
            );

            // Видалення об'єкта
            await client.query(
                'DELETE FROM wialon.objects WHERE id = $1',
                [id]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'OBJECT_DELETE',
                entityType: 'WIALON_OBJECT',
                entityId: id,
                oldValues: objectData.rows[0],
                ipAddress: req.ip,
                tableSchema: 'wialon',
                tableName: 'objects',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return { success: true };
        } catch (error) {
            throw error;
        }
    }
}

module.exports = WialonService;