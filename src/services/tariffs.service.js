const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

class TariffService {
    // Отримання списку тарифів з фільтрацією та пагінацією
    static async getTariffs(filters) {
        const {
            page = 1,
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            is_active = null
        } = filters;

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                t.name ILIKE $${paramIndex} OR
                t.description ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (is_active !== null) {
            conditions.push(`t.is_active = $${paramIndex}`);
            params.push(is_active === 'true' || is_active === true);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
        
        // Визначення поля для сортування
        let orderByField;
        switch(sortBy) {
            case 'name':
                orderByField = 't.name';
                break;
            case 'price':
                orderByField = 't.price';
                break;
            case 'is_active':
                orderByField = 't.is_active';
                break;
            case 'created_at':
                orderByField = 't.created_at';
                break;
            default:
                orderByField = 't.name';
        }

        // Обробка опції "всі записи" для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        let query = `
            SELECT 
                t.*,
                COUNT(DISTINCT ot.object_id) as objects_count
            FROM billing.tariffs t
            LEFT JOIN billing.object_tariffs ot ON t.id = ot.tariff_id AND ot.effective_to IS NULL
            ${whereClause}
            GROUP BY t.id
            ORDER BY ${orderByField} ${orderDirection}
        `;

        if (limit !== null) {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
        }

        const countQuery = `
            SELECT COUNT(*) FROM billing.tariffs t
            ${whereClause}
        `;

        const [tariffsResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
        ]);

        return {
            tariffs: tariffsResult.rows,
            total: parseInt(countResult.rows[0].count)
        };
    }

    // Отримання тарифу за ID з детальною інформацією
    static async getTariffById(id) {
        const tariffQuery = `
            SELECT 
                t.*,
                COUNT(DISTINCT ot.object_id) as objects_count
            FROM billing.tariffs t
            LEFT JOIN billing.object_tariffs ot ON t.id = ot.tariff_id AND ot.effective_to IS NULL
            WHERE t.id = $1
            GROUP BY t.id
        `;

        const result = await pool.query(tariffQuery, [id]);
        
        if (result.rows.length === 0) {
            return null;
        }

        // Отримуємо об'єкти на цьому тарифі
        const objectsQuery = `
            SELECT 
                o.id,
                o.name,
                o.wialon_id,
                c.name as client_name,
                ot.effective_from,
                ot.effective_to
            FROM billing.object_tariffs ot
            JOIN wialon.objects o ON ot.object_id = o.id
            JOIN clients.clients c ON o.client_id = c.id
            WHERE ot.tariff_id = $1 AND ot.effective_to IS NULL
            ORDER BY ot.effective_from DESC
        `;

        const objectsResult = await pool.query(objectsQuery, [id]);
        
        const tariff = result.rows[0];
        tariff.objects = objectsResult.rows;
        
        return tariff;
    }

    // Створення нового тарифу
    static async createTariff(client, data, userId, req) {
        try {
            const { 
                name, description, price, is_active 
            } = data;

            // Перевірка наявності тарифу з такою назвою
            const existingTariff = await client.query(
                'SELECT id FROM billing.tariffs WHERE name = $1',
                [name]
            );

            if (existingTariff.rows.length > 0) {
                throw new Error('Тариф з такою назвою вже існує');
            }

            // Створення тарифу
            const result = await client.query(
                `INSERT INTO billing.tariffs (
                    name, description, price, is_active
                )
                VALUES ($1, $2, $3, $4)
                RETURNING *`,
                [
                    name, 
                    description, 
                    price, 
                    is_active !== undefined ? is_active : true
                ]
            );

            const newTariff = result.rows[0];

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'TARIFF_CREATE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'TARIFF',  // Це потрібно додати в ENTITY_TYPES
                entityId: newTariff.id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'tariffs',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return newTariff;
        } catch (error) {
            throw error;
        }
    }

    // Оновлення існуючого тарифу
    static async updateTariff(client, id, data, userId, req) {
        try {
            // Отримання поточних даних тарифу для аудиту
            const currentTariff = await client.query(
                'SELECT * FROM billing.tariffs WHERE id = $1',
                [id]
            );

            if (currentTariff.rows.length === 0) {
                throw new Error('Тариф не знайдений');
            }

            const oldData = currentTariff.rows[0];

            // Перевірка унікальності назви
            if (data.name && data.name !== oldData.name) {
                const existingTariff = await client.query(
                    'SELECT id FROM billing.tariffs WHERE name = $1 AND id != $2',
                    [data.name, id]
                );

                if (existingTariff.rows.length > 0) {
                    throw new Error('Тариф з такою назвою вже існує');
                }
            }

            // Підготовка оновлених даних
            const updateFields = [];
            const updateValues = [];
            let paramIndex = 1;

            const fieldsToUpdate = [
                'name', 'description', 'price', 'is_active'
            ];

            for (const field of fieldsToUpdate) {
                if (data[field] !== undefined) {
                    updateFields.push(`${field} = $${paramIndex++}`);
                    updateValues.push(data[field]);
                }
            }

            updateFields.push(`updated_at = $${paramIndex++}`);
            updateValues.push(new Date());
            updateValues.push(id);

            // Оновлення тарифу
            const result = await client.query(
                `UPDATE billing.tariffs 
                 SET ${updateFields.join(', ')}
                 WHERE id = $${paramIndex}
                 RETURNING *`,
                updateValues
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'TARIFF_UPDATE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'TARIFF',  // Це потрібно додати в ENTITY_TYPES
                entityId: id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'tariffs',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Видалення тарифу
    static async deleteTariff(client, id, userId, req) {
        try {
            // Перевірка чи є об'єкти на цьому тарифі
            const objectsCheck = await client.query(
                'SELECT object_id FROM billing.object_tariffs WHERE tariff_id = $1 AND effective_to IS NULL LIMIT 1',
                [id]
            );

            if (objectsCheck.rows.length > 0) {
                throw new Error('Неможливо видалити тариф, який використовується об\'єктами');
            }

            // Отримання даних тарифу для аудиту
            const tariffData = await client.query(
                'SELECT * FROM billing.tariffs WHERE id = $1',
                [id]
            );

            if (tariffData.rows.length === 0) {
                throw new Error('Тариф не знайдений');
            }

            // Видалення історичних записів про тариф
            await client.query(
                'DELETE FROM billing.object_tariffs WHERE tariff_id = $1 AND effective_to IS NOT NULL',
                [id]
            );

            // Видалення тарифу
            await client.query(
                'DELETE FROM billing.tariffs WHERE id = $1',
                [id]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'TARIFF_DELETE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'TARIFF',  // Це потрібно додати в ENTITY_TYPES
                entityId: id,
                oldValues: tariffData.rows[0],
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'tariffs',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return { success: true };
        } catch (error) {
            throw error;
        }
    }
// Додавання методу для визначення оптимальної дати зміни тарифу
static async getOptimalTariffChangeDate(objectId) {
    try {
        // Використовуємо функцію в БД для визначення дати
        const result = await pool.query(
            'SELECT billing.get_optimal_tariff_change_date($1) as change_date',
            [objectId]
        );
        
        return result.rows[0].change_date;
    } catch (error) {
        throw error;
    }
}

// Модифікація методу для призначення тарифу з врахуванням оплачених періодів
static async assignTariffToObject(client, data, userId, req) {
    try {
        const { object_id, tariff_id, effective_from, notes, use_optimal_date = false } = data;

        if (!object_id || !tariff_id) {
            throw new Error('ID об\'єкта та тарифу обов\'язкові');
        }

        // Перевірка наявності об'єкта
        const objectExists = await client.query(
            'SELECT id, status FROM wialon.objects WHERE id = $1',
            [object_id]
        );

        if (objectExists.rows.length === 0) {
            throw new Error('Вказаний об\'єкт не існує');
        }

        // Перевірка наявності тарифу
        const tariffExists = await client.query(
            'SELECT id, price FROM billing.tariffs WHERE id = $1',
            [tariff_id]
        );

        if (tariffExists.rows.length === 0) {
            throw new Error('Вказаний тариф не існує');
        }

        // Перевірка чи є вже активний тариф
        const currentTariff = await client.query(
            `SELECT id, tariff_id FROM billing.object_tariffs 
             WHERE object_id = $1 AND effective_to IS NULL`,
            [object_id]
        );

        // Якщо вказано use_optimal_date=true, визначаємо оптимальну дату зміни тарифу
        let effectiveDate;
        if (use_optimal_date) {
            const optimalDateResult = await client.query(
                'SELECT billing.get_optimal_tariff_change_date($1) as change_date',
                [object_id]
            );
            
            effectiveDate = optimalDateResult.rows[0].change_date;
            
            // Якщо оптимальна дата відсутня (помилка функції), використовуємо поточну дату
            if (!effectiveDate) {
                effectiveDate = new Date();
            }
        } else {
            // Інакше використовуємо вказану дату або поточну
            effectiveDate = effective_from ? new Date(effective_from) : new Date();
        }

        // Якщо є активний тариф і він такий самий як новий тариф, перевіряємо чи змінюється дата
        if (currentTariff.rows.length > 0 && currentTariff.rows[0].tariff_id === tariff_id) {
            // Отримуємо дату поточного тарифу
            const currentTariffDate = await client.query(
                `SELECT effective_from FROM billing.object_tariffs WHERE id = $1`,
                [currentTariff.rows[0].id]
            );

            // Якщо дати збігаються, нічого не робимо
            if (currentTariffDate.rows[0].effective_from.toISOString().split('T')[0] === 
                effectiveDate.toISOString().split('T')[0]) {
                throw new Error('Цей тариф вже призначений об\'єкту з вказаною датою');
            }
        }

        // Перевіряємо, чи це майбутня дата
        const isFutureDate = effectiveDate.getTime() > Date.now();
        
        // Якщо це майбутня дата і є активний тариф, то створюємо запланований перехід
        if (isFutureDate && currentTariff.rows.length > 0) {
            // Створюємо новий запис з майбутньою датою без закриття поточного тарифу
            const result = await client.query(
                `INSERT INTO billing.object_tariffs (
                    object_id, tariff_id, effective_from, notes, created_by
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [
                    object_id, 
                    tariff_id, 
                    effectiveDate, 
                    notes ? notes + ' (Заплановано)' : 'Заплановано', 
                    userId
                ]
            );
            
            // Відзначаємо цей запис як запланований (можна додати атрибут або метадані)
            await client.query(
                `INSERT INTO wialon.object_attributes (
                    object_id, attribute_name, attribute_value
                )
                VALUES ($1, $2, $3)
                ON CONFLICT (object_id, attribute_name) 
                DO UPDATE SET attribute_value = $3`,
                [
                    object_id, 
                    'planned_tariff_change', 
                    JSON.stringify({
                        tariff_id: tariff_id,
                        effective_from: effectiveDate.toISOString(),
                        planned_by: userId
                    })
                ]
            );
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'TARIFF_PLANNED',
                entityType: 'OBJECT_TARIFF',
                entityId: result.rows[0].id,
                newValues: {...data, effective_from: effectiveDate, is_planned: true},
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'object_tariffs',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
            
            return { ...result.rows[0], is_planned: true };
        } 
        // Стандартний шлях для негайної зміни тарифу
        else {
            // Якщо є активний тариф, закриваємо його
            if (currentTariff.rows.length > 0) {
                await client.query(
                    `UPDATE billing.object_tariffs 
                     SET effective_to = $1
                     WHERE id = $2`,
                    [effectiveDate, currentTariff.rows[0].id]
                );
            }

            // Додаємо новий запис тарифу
            const result = await client.query(
                `INSERT INTO billing.object_tariffs (
                    object_id, tariff_id, effective_from, notes, created_by
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [
                    object_id, 
                    tariff_id, 
                    effectiveDate, 
                    notes, 
                    userId
                ]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'TARIFF_ASSIGN',
                entityType: 'OBJECT_TARIFF',
                entityId: result.rows[0].id,
                newValues: {...data, effective_from: effectiveDate},
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'object_tariffs',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        }
    } catch (error) {
        throw error;
    }
}

// Додаємо метод для відміни запланованої зміни тарифу
static async cancelPlannedTariffChange(client, objectId, userId, req) {
    try {
        // Перевірка наявності об'єкта
        const objectExists = await client.query(
            'SELECT id FROM wialon.objects WHERE id = $1',
            [objectId]
        );

        if (objectExists.rows.length === 0) {
            throw new Error('Вказаний об\'єкт не існує');
        }

        // Перевірка наявності запланованої зміни
        const plannedAttribute = await client.query(
            `SELECT attribute_value FROM wialon.object_attributes 
             WHERE object_id = $1 AND attribute_name = 'planned_tariff_change'`,
            [objectId]
        );

        if (plannedAttribute.rows.length === 0) {
            throw new Error('Немає запланованих змін тарифу для цього об\'єкта');
        }

        // Отримуємо дані запланованої зміни
        const plannedChange = JSON.parse(plannedAttribute.rows[0].attribute_value);
        const plannedDate = new Date(plannedChange.effective_from);

        // Видалення запису запланованого тарифу
        await client.query(
            `DELETE FROM billing.object_tariffs 
             WHERE object_id = $1 
             AND tariff_id = $2 
             AND effective_from = $3
             AND effective_to IS NULL`,
            [objectId, plannedChange.tariff_id, plannedDate]
        );

        // Видалення атрибуту з плануванням
        await client.query(
            `DELETE FROM wialon.object_attributes 
             WHERE object_id = $1 AND attribute_name = 'planned_tariff_change'`,
            [objectId]
        );

        // Аудит
        await AuditService.log({
            userId,
            actionType: 'TARIFF_PLAN_CANCEL',
            entityType: 'OBJECT_TARIFF',
            entityId: objectId,
            oldValues: plannedChange,
            ipAddress: req.ip,
            tableSchema: 'wialon',
            tableName: 'object_attributes',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return { success: true, cancelled_plan: plannedChange };
    } catch (error) {
        throw error;
    }
}

// Додавання методу для отримання запланованих змін тарифів
static async getPlannedTariffChanges(filters = {}) {
    const {
        page = 1,
        perPage = 10,
        client_id = null
    } = filters;

    let whereClause = '';
    let params = [];
    let paramIndex = 1;

    if (client_id) {
        whereClause = `WHERE o.client_id = $${paramIndex}`;
        params.push(client_id);
        paramIndex++;
    }

    // Обробка опції "всі записи" для експорту
    const limit = perPage === 'All' ? null : parseInt(perPage);
    const offset = limit ? (parseInt(page) - 1) * limit : 0;

    // Отримуємо всі об'єкти з запланованою зміною тарифу
    let query = `
        SELECT 
            o.id as object_id, 
            o.name as object_name,
            c.id as client_id,
            c.name as client_name,
            oa.attribute_value::jsonb as planned_change,
            t.name as tariff_name,
            t.price as tariff_price,
            ot.tariff_id as current_tariff_id,
            current_t.name as current_tariff_name,
            current_t.price as current_tariff_price
        FROM wialon.objects o
        JOIN clients.clients c ON o.client_id = c.id
        JOIN wialon.object_attributes oa ON o.id = oa.object_id
        JOIN billing.tariffs t ON (oa.attribute_value::jsonb->>'tariff_id')::uuid = t.id
        LEFT JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
        LEFT JOIN billing.tariffs current_t ON ot.tariff_id = current_t.id
        WHERE oa.attribute_name = 'planned_tariff_change'
        ${whereClause}
        ORDER BY (oa.attribute_value::jsonb->>'effective_from')::timestamp
    `;

    if (limit !== null) {
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
    }

    const countQuery = `
        SELECT COUNT(*) 
        FROM wialon.objects o
        JOIN wialon.object_attributes oa ON o.id = oa.object_id
        WHERE oa.attribute_name = 'planned_tariff_change'
        ${whereClause}
    `;

    const [changesResult, countResult] = await Promise.all([
        pool.query(query, params),
        pool.query(countQuery, client_id ? [client_id] : [])
    ]);

    // Перетворюємо результати для читабельності
    const plannedChanges = changesResult.rows.map(row => {
        const planned = row.planned_change;
        const plannedDate = new Date(planned.effective_from);
        
        return {
            object_id: row.object_id,
            object_name: row.object_name,
            client_id: row.client_id,
            client_name: row.client_name,
            current_tariff_id: row.current_tariff_id,
            current_tariff_name: row.current_tariff_name,
            current_tariff_price: row.current_tariff_price,
            planned_tariff_id: planned.tariff_id,
            planned_tariff_name: row.tariff_name,
            planned_tariff_price: row.tariff_price,
            effective_from: plannedDate,
            planned_by: planned.planned_by
        };
    });

    return {
        planned_changes: plannedChanges,
        total: parseInt(countResult.rows[0].count)
    };
}

    // Призначення тарифу об'єкту
    static async assignTariffToObject(client, data, userId, req) {
        try {
            const { object_id, tariff_id, effective_from, notes } = data;

            if (!object_id || !tariff_id) {
                throw new Error('ID об\'єкта та тарифу обов\'язкові');
            }

            // Перевірка наявності об'єкта
            const objectExists = await client.query(
                'SELECT id FROM wialon.objects WHERE id = $1',
                [object_id]
            );

            if (objectExists.rows.length === 0) {
                throw new Error('Вказаний об\'єкт не існує');
            }

            // Перевірка наявності тарифу
            const tariffExists = await client.query(
                'SELECT id FROM billing.tariffs WHERE id = $1',
                [tariff_id]
            );

            if (tariffExists.rows.length === 0) {
                throw new Error('Вказаний тариф не існує');
            }

            // Перевірка чи є вже активний тариф
            const currentTariff = await client.query(
                `SELECT id, tariff_id FROM billing.object_tariffs 
                 WHERE object_id = $1 AND effective_to IS NULL`,
                [object_id]
            );

            const effectiveDate = effective_from ? new Date(effective_from) : new Date();

            // Якщо є активний тариф, закриваємо його
            if (currentTariff.rows.length > 0) {
                // Якщо новий тариф такий самий як поточний, нічого не робимо
                if (currentTariff.rows[0].tariff_id === tariff_id) {
                    throw new Error('Цей тариф вже призначений об\'єкту');
                }

                await client.query(
                    `UPDATE billing.object_tariffs 
                     SET effective_to = $1
                     WHERE id = $2`,
                    [effectiveDate, currentTariff.rows[0].id]
                );
            }

            // Додаємо новий запис тарифу
            const result = await client.query(
                `INSERT INTO billing.object_tariffs (
                    object_id, tariff_id, effective_from, notes, created_by
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [
                    object_id, 
                    tariff_id, 
                    effectiveDate, 
                    notes, 
                    userId
                ]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'TARIFF_ASSIGN',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'OBJECT_TARIFF',  // Це потрібно додати в ENTITY_TYPES
                entityId: result.rows[0].id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'object_tariffs',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Отримання історії тарифів для об'єкта
    static async getObjectTariffHistory(objectId) {
        const query = `
            SELECT 
                ot.*,
                t.name as tariff_name,
                t.price,
                u.email as created_by_email,
                u.first_name || ' ' || u.last_name as created_by_name
            FROM billing.object_tariffs ot
            JOIN billing.tariffs t ON ot.tariff_id = t.id
            LEFT JOIN auth.users u ON ot.created_by = u.id
            WHERE ot.object_id = $1
            ORDER BY ot.effective_from DESC
        `;

        const result = await pool.query(query, [objectId]);
        return result.rows;
    }
}

module.exports = TariffService;