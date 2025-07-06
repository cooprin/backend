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
                'name', 'description', 'is_active'
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

static async assignTariffToObject(client, data, userId, req) {
    try {
        const { object_id, tariff_id, effective_from, notes } = data;

        if (!object_id || !tariff_id) {
            throw new Error('ID об\'єкта та тарифу обов\'язкові');
        }

        // Перевірка наявності об'єкта
        const objectExists = await client.query(
            'SELECT id, status, client_id FROM wialon.objects WHERE id = $1',
            [object_id]
        );

        if (objectExists.rows.length === 0) {
            throw new Error('Вказаний об\'єкт не існує');
        }

        const objectData = objectExists.rows[0];

        // Перевірка наявності тарифу
        const tariffExists = await client.query(
            'SELECT id, price, name FROM billing.tariffs WHERE id = $1',
            [tariff_id]
        );

        if (tariffExists.rows.length === 0) {
            throw new Error('Вказаний тариф не існує');
        }

        const tariffData = tariffExists.rows[0];

        // Розбираємося з датою початку дії
        let effectiveDate;
        if (effective_from) {
            effectiveDate = new Date(effective_from);
        } else {
            // Якщо дата не вказана, використовуємо оптимальну дату
            const optimalDateResult = await client.query(
                'SELECT billing.get_optimal_tariff_change_date($1) as optimal_date',
                [object_id]
            );
            effectiveDate = optimalDateResult.rows[0].optimal_date;
        }

        // Перевірка існуючих тарифів - не можна встановлювати попередню або таку саму дату
        const existingTariffsCheck = await client.query(
            `SELECT ot.id, ot.effective_from, ot.tariff_id, t.name as tariff_name
             FROM billing.object_tariffs ot
             JOIN billing.tariffs t ON ot.tariff_id = t.id
             WHERE ot.object_id = $1 
             AND ot.effective_from >= $2
             ORDER BY ot.effective_from DESC`,
            [object_id, effectiveDate]
        );

        if (existingTariffsCheck.rows.length > 0) {
            const existingTariff = existingTariffsCheck.rows[0];
            throw new Error(
                `Неможливо встановити тариф на ${effectiveDate.toLocaleDateString()}, ` +
                `оскільки існує тариф "${existingTariff.tariff_name}" ` +
                `з ${new Date(existingTariff.effective_from).toLocaleDateString()}. ` +
                `Можна встановити тариф тільки на більш пізню дату.`
            );
        }

        // Перевірка оплат за поточний місяць - якщо є оплата, не можна змінювати тариф цього місяця
        const effectiveMonth = effectiveDate.getMonth() + 1;
        const effectiveYear = effectiveDate.getFullYear();

        const currentMonthPaymentCheck = await client.query(
            `SELECT COUNT(*) as payment_count
             FROM billing.object_payment_records
             WHERE object_id = $1 
             AND billing_year = $2 
             AND billing_month = $3
             AND status IN ('paid', 'partial')`,
            [object_id, effectiveYear, effectiveMonth]
        );

        if (parseInt(currentMonthPaymentCheck.rows[0].payment_count) > 0) {
            throw new Error(
                `Неможливо встановити тариф на ${effectiveDate.toLocaleDateString()}, ` +
                `оскільки за ${effectiveMonth}/${effectiveYear} вже є оплата. ` +
                `Тариф можна встановити тільки на наступний місяць.`
            );
        }
        // Перевірка, чи є вже активний тариф
        const currentTariff = await client.query(
            `SELECT id, tariff_id, effective_from FROM billing.object_tariffs 
             WHERE object_id = $1 AND effective_to IS NULL`,
            [object_id]
        );

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

        return {
            ...result.rows[0],
            optimal_date: optimalDate,
            is_optimal_date_used: effectiveDate.getTime() === optimalDate.getTime()
        };
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