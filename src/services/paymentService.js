const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const ExcelJS = require('exceljs');

class PaymentService {
    // Отримання списку платежів з фільтрацією та пагінацією

static async getPayments(filters) {
    const {
        page = 1,
        perPage = 10,
        sortBy = 'payment_date',
        descending = true,
        search = '',
        clientId = null,
        paymentType = null,
        from = null,
        to = null,
        month = null,
        year = null
    } = filters;

    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (search) {
        conditions.push(`(
            c.name ILIKE $${paramIndex} OR
            p.notes ILIKE $${paramIndex}
        )`);
        params.push(`%${search}%`);
        paramIndex++;
    }

    if (clientId) {
        conditions.push(`p.client_id = $${paramIndex}`);
        params.push(clientId);
        paramIndex++;
    }

    if (paymentType) {
        conditions.push(`p.payment_type = $${paramIndex}`);
        params.push(paymentType);
        paramIndex++;
    }

    if (from) {
        conditions.push(`p.payment_date >= $${paramIndex}`);
        params.push(from);
        paramIndex++;
    }

    if (to) {
        conditions.push(`p.payment_date <= $${paramIndex}`);
        params.push(to);
        paramIndex++;
    }

    if (month) {
        conditions.push(`p.payment_month = $${paramIndex}`);
        params.push(parseInt(month));
        paramIndex++;
    }

    if (year) {
        conditions.push(`p.payment_year = $${paramIndex}`);
        params.push(parseInt(year));
        paramIndex++;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
    
    // Визначення поля для сортування
    let orderByField;
    switch(sortBy) {
        case 'payment_date':
            orderByField = 'p.payment_date';
            break;
        case 'client_name':
            orderByField = 'c.name';
            break;
        case 'amount':
            orderByField = 'p.amount';
            break;
        case 'payment_type':
            orderByField = 'p.payment_type';
            break;
        case 'payment_period':
            orderByField = 'p.payment_year, p.payment_month';
            break;
        default:
            orderByField = 'p.payment_date';
    }

    // Обробка опції "всі записи" для експорту
    const limit = perPage === 'All' ? null : parseInt(perPage);
    const offset = limit ? (parseInt(page) - 1) * limit : 0;
    
    // Змінений запит - прибрали join з auth.users та посилання на u.username
    let query = `
        SELECT 
            p.*,
            c.name as client_name
        FROM billing.payments p
        JOIN clients.clients c ON p.client_id = c.id
        ${whereClause}
        ORDER BY ${orderByField} ${orderDirection}
    `;

    if (limit !== null) {
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
    }

    const countQuery = `
        SELECT COUNT(*) FROM billing.payments p
        JOIN clients.clients c ON p.client_id = c.id
        ${whereClause}
    `;

    const [paymentsResult, countResult] = await Promise.all([
        pool.query(query, params),
        pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
    ]);

    return {
        payments: paymentsResult.rows,
        total: parseInt(countResult.rows[0].count)
    };
}

    // Отримання платежів клієнта
    static async getClientPayments(clientId, filters = {}) {
        filters.clientId = clientId;
        return this.getPayments(filters);
    }

    // Отримання деталей платежу
static async getPaymentDetails(id) {
    const query = `
        SELECT 
            p.*,
            c.name as client_name,
            (
                SELECT json_agg(
                    jsonb_build_object(
                        'id', i.id,
                        'invoice_number', i.invoice_number,
                        'billing_month', i.billing_month,
                        'billing_year', i.billing_year,
                        'total_amount', i.total_amount,
                        'status', i.status
                    )
                )
                FROM services.invoices i
                WHERE i.payment_id = p.id
            ) as invoices,
            (
                SELECT json_agg(
                    jsonb_build_object(
                        'id', opr.id,
                        'object_id', opr.object_id,
                        'object_name', o.name,
                        'amount', opr.amount,
                        'tariff_id', opr.tariff_id,
                        'tariff_name', t.name,
                        'billing_month', opr.billing_month,
                        'billing_year', opr.billing_year,
                        'status', opr.status
                    )
                )
                FROM billing.object_payment_records opr
                JOIN wialon.objects o ON opr.object_id = o.id
                JOIN billing.tariffs t ON opr.tariff_id = t.id
                WHERE opr.payment_id = p.id
            ) as object_payments
        FROM billing.payments p
        JOIN clients.clients c ON p.client_id = c.id
        WHERE p.id = $1
    `;

    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
        return null;
    }
    
    return result.rows[0];
}

    // Створення нового платежу
    static async createPayment(client, data, userId, req) {
        try {
            const { 
                client_id, amount, payment_date, payment_type = 'regular', 
                invoice_id, notes, object_payments 
            } = data;

            if (!client_id || !amount || !payment_date) {
                throw new Error('ID клієнта, сума та дата платежу обов\'язкові');
            }

            // Перевірка наявності клієнта
            const clientExists = await client.query(
                'SELECT id FROM clients.clients WHERE id = $1',
                [client_id]
            );

            if (clientExists.rows.length === 0) {
                throw new Error('Вказаний клієнт не існує');
            }

            // Отримання місяця і року з дати платежу
            const paymentDateObj = new Date(payment_date);
            const paymentMonth = paymentDateObj.getMonth() + 1;
            const paymentYear = paymentDateObj.getFullYear();

            // Створення платежу
            const paymentResult = await client.query(
                `INSERT INTO billing.payments (
                    client_id, amount, payment_date, payment_month, 
                    payment_year, payment_type, notes, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *`,
                [
                    client_id,
                    amount,
                    payment_date,
                    paymentMonth,
                    paymentYear,
                    payment_type,
                    notes,
                    userId
                ]
            );

            const paymentId = paymentResult.rows[0].id;

            // Якщо вказано invoice_id, зв'язуємо платіж з рахунком
            if (invoice_id) {
                await client.query(
                    `UPDATE services.invoices 
                     SET status = 'paid', payment_id = $1, updated_at = $2
                     WHERE id = $3`,
                    [paymentId, new Date(), invoice_id]
                );
            }

            // Якщо надані дані про оплату по об'єктах, зберігаємо їх
            if (object_payments && Array.isArray(object_payments) && object_payments.length > 0) {
                for (const objPayment of object_payments) {
                    await client.query(
                        `INSERT INTO billing.object_payment_records (
                            object_id, payment_id, tariff_id, amount,
                            billing_month, billing_year, status
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            objPayment.object_id,
                            paymentId,
                            objPayment.tariff_id,
                            objPayment.amount,
                            objPayment.billing_month || paymentMonth,
                            objPayment.billing_year || paymentYear,
                            objPayment.status || 'paid'
                        ]
                    );
                }
            }

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'PAYMENT_CREATE',
                entityType: 'PAYMENT',
                entityId: paymentId,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'payments',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return paymentResult.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Оновлення платежу
    static async updatePayment(client, id, data, userId, req) {
        try {
            // Отримання поточних даних платежу для аудиту
            const currentPayment = await client.query(
                'SELECT * FROM billing.payments WHERE id = $1',
                [id]
            );

            if (currentPayment.rows.length === 0) {
                throw new Error('Платіж не знайдено');
            }

            const oldData = currentPayment.rows[0];

            // Підготовка оновлених даних
            const updateFields = [];
            const updateValues = [];
            let paramIndex = 1;

            const fieldsToUpdate = [
                'amount', 'payment_date', 'payment_type', 'notes'
            ];

            for (const field of fieldsToUpdate) {
                if (data[field] !== undefined) {
                    updateFields.push(`${field} = $${paramIndex++}`);
                    updateValues.push(data[field]);
                }
            }

            // Якщо змінюється дата платежу, оновлюємо місяць і рік
            if (data.payment_date) {
                const paymentDateObj = new Date(data.payment_date);
                const paymentMonth = paymentDateObj.getMonth() + 1;
                const paymentYear = paymentDateObj.getFullYear();
                
                updateFields.push(`payment_month = $${paramIndex++}`);
                updateValues.push(paymentMonth);
                
                updateFields.push(`payment_year = $${paramIndex++}`);
                updateValues.push(paymentYear);
            }

            if (updateFields.length === 0) {
                throw new Error('Не вказано полів для оновлення');
            }

            updateValues.push(id);

            // Оновлення платежу
            const result = await client.query(
                `UPDATE billing.payments 
                 SET ${updateFields.join(', ')}
                 WHERE id = $${paramIndex}
                 RETURNING *`,
                updateValues
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'PAYMENT_UPDATE',
                entityType: 'PAYMENT',
                entityId: id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'payments',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Видалення платежу
    static async deletePayment(client, id, userId, req) {
        try {
            // Отримання поточних даних платежу для аудиту
            const currentPayment = await client.query(
                'SELECT * FROM billing.payments WHERE id = $1',
                [id]
            );

            if (currentPayment.rows.length === 0) {
                throw new Error('Платіж не знайдено');
            }

            // Перевірка чи є рахунки, пов'язані з цим платежем
            const invoicesCheck = await client.query(
                'SELECT id FROM services.invoices WHERE payment_id = $1',
                [id]
            );

            if (invoicesCheck.rows.length > 0) {
                // Змінюємо статус рахунків на "issued"
                await client.query(
                    `UPDATE services.invoices 
                     SET status = 'issued', payment_id = NULL
                     WHERE payment_id = $1`,
                    [id]
                );
            }

            // Видалення записів про оплату об'єктів
            await client.query(
                'DELETE FROM billing.object_payment_records WHERE payment_id = $1',
                [id]
            );

            // Видалення платежу
            await client.query(
                'DELETE FROM billing.payments WHERE id = $1',
                [id]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'PAYMENT_DELETE',
                entityType: 'PAYMENT',
                entityId: id,
                oldValues: currentPayment.rows[0],
                ipAddress: req.ip,
                tableSchema: 'billing',
                tableName: 'payments',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    // Отримання статистики платежів
    static async getPaymentsStatistics(filters) {
        const { 
            clientId = null, 
            year = new Date().getFullYear(), 
            from = null, 
            to = null 
        } = filters;

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (clientId) {
            conditions.push(`p.client_id = $${paramIndex}`);
            params.push(clientId);
            paramIndex++;
        }

        if (year) {
            conditions.push(`p.payment_year = $${paramIndex}`);
            params.push(parseInt(year));
            paramIndex++;
        }

        if (from) {
            conditions.push(`p.payment_date >= $${paramIndex}`);
            params.push(from);
            paramIndex++;
        }

        if (to) {
            conditions.push(`p.payment_date <= $${paramIndex}`);
            params.push(to);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        // Загальна статистика
        const summaryQuery = `
            SELECT 
                SUM(p.amount) as total_amount,
                COUNT(DISTINCT p.id) as payments_count,
                COUNT(DISTINCT p.client_id) as clients_count
            FROM billing.payments p
            ${whereClause}
        `;

        // Статистика по місяцях
        const monthlyQuery = `
            SELECT 
                p.payment_month as month,
                SUM(p.amount) as monthly_amount,
                COUNT(p.id) as monthly_count
            FROM billing.payments p
            ${whereClause}
            GROUP BY p.payment_month
            ORDER BY p.payment_month
        `;

        // Статистика по типах платежів
        const paymentTypesQuery = `
            SELECT 
                p.payment_type,
                SUM(p.amount) as type_amount,
                COUNT(p.id) as type_count
            FROM billing.payments p
            ${whereClause}
            GROUP BY p.payment_type
        `;

        // Статистика по клієнтах (топ-5)
        const clientsQuery = `
            SELECT 
                p.client_id,
                c.name as client_name,
                SUM(p.amount) as client_amount,
                COUNT(p.id) as client_count
            FROM billing.payments p
            JOIN clients.clients c ON p.client_id = c.id
            ${whereClause}
            GROUP BY p.client_id, c.name
            ORDER BY client_amount DESC
            LIMIT 5
        `;

        const [summaryResult, monthlyResult, typesResult, clientsResult] = await Promise.all([
            pool.query(summaryQuery, params),
            pool.query(monthlyQuery, params),
            pool.query(paymentTypesQuery, params),
            pool.query(clientsQuery, params)
        ]);

        return {
            summary: summaryResult.rows[0],
            monthly: monthlyResult.rows,
            paymentTypes: typesResult.rows,
            topClients: clientsResult.rows
        };
    }

    // Отримання історії платежів за об'єктом
    static async getObjectPaymentHistory(objectId, filters = {}) {
        const {
            page = 1,
            perPage = 10,
            sortBy = 'billing_period',
            descending = true,
            year = null,
            month = null
        } = filters;

        let conditions = [`opr.object_id = $1`];
        let params = [objectId];
        let paramIndex = 2;

        if (year) {
            conditions.push(`opr.billing_year = $${paramIndex}`);
            params.push(parseInt(year));
            paramIndex++;
        }

        if (month) {
            conditions.push(`opr.billing_month = $${paramIndex}`);
            params.push(parseInt(month));
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
        
        // Визначення поля для сортування
        let orderByField;
        switch(sortBy) {
            case 'payment_date':
                orderByField = 'p.payment_date';
                break;
            case 'billing_period':
                orderByField = 'opr.billing_year, opr.billing_month';
                break;
            case 'amount':
                orderByField = 'opr.amount';
                break;
            case 'status':
                orderByField = 'opr.status';
                break;
            default:
                orderByField = 'p.payment_date';
        }

        // Обробка опції "всі записи" для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        let query = `
            SELECT 
                opr.*,
                p.payment_date,
                p.payment_type,
                t.name as tariff_name,
                t.price as tariff_price,
                c.name as client_name
            FROM billing.object_payment_records opr
            JOIN billing.payments p ON opr.payment_id = p.id
            JOIN billing.tariffs t ON opr.tariff_id = t.id
            JOIN clients.clients c ON p.client_id = c.id
            ${whereClause}
            ORDER BY ${orderByField} ${orderDirection}
        `;

        if (limit !== null) {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
        }

        const countQuery = `
            SELECT COUNT(*) FROM billing.object_payment_records opr
            JOIN billing.payments p ON opr.payment_id = p.id
            ${whereClause}
        `;

        // Запит для отримання інформації про об'єкт
        const objectQuery = `
            SELECT 
                o.*,
                c.name as client_name,
                (SELECT t.name FROM billing.tariffs t 
                JOIN billing.object_tariffs ot ON t.id = ot.tariff_id 
                WHERE ot.object_id = o.id AND ot.effective_to IS NULL) as current_tariff,
                (SELECT t.price FROM billing.tariffs t 
                JOIN billing.object_tariffs ot ON t.id = ot.tariff_id 
                WHERE ot.object_id = o.id AND ot.effective_to IS NULL) as current_price
            FROM wialon.objects o
            JOIN clients.clients c ON o.client_id = c.id
            WHERE o.id = $1
        `;

        const [paymentsResult, countResult, objectResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, params.slice(0, paramIndex - 1)),
            pool.query(objectQuery, [objectId])
        ]);

        return {
            payments: paymentsResult.rows,
            total: parseInt(countResult.rows[0].count),
            object: objectResult.rows[0] || null
        };
    }

    // Експорт платежів в Excel
    static async exportPayments(filters) {
        // Отримуємо дані платежів без пагінації
        const paymentsData = await this.getPayments({
            ...filters,
            perPage: 'All'
        });

        // Створюємо новий Excel файл
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Платежі');

        // Встановлюємо заголовки
        worksheet.columns = [
            { header: 'Дата', key: 'payment_date', width: 15 },
            { header: 'Клієнт', key: 'client_name', width: 25 },
            { header: 'Сума', key: 'amount', width: 15 },
            { header: 'Тип платежу', key: 'payment_type', width: 15 },
            { header: 'Місяць', key: 'payment_month', width: 10 },
            { header: 'Рік', key: 'payment_year', width: 10 },
            { header: 'Примітки', key: 'notes', width: 30 },
            { header: 'Створено', key: 'created_by_username', width: 15 }
        ];

        // Додаємо дані
        paymentsData.payments.forEach(payment => {
            const paymentType = {
                'regular': 'Звичайний',
                'advance': 'Аванс',
                'debt': 'Борг',
                'adjustment': 'Коригування'
            }[payment.payment_type] || payment.payment_type;

            worksheet.addRow({
                payment_date: new Date(payment.payment_date).toLocaleDateString('uk-UA'),
                client_name: payment.client_name,
                amount: payment.amount,
                payment_type: paymentType,
                payment_month: payment.payment_month,
                payment_year: payment.payment_year,
                notes: payment.notes,
                created_by_username: payment.created_by_username
            });
        });

        // Стилізація заголовків
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

        // Стилізація стовпця з сумою
        worksheet.getColumn('amount').numFmt = '#,##0.00 ₴';

        // Встановлюємо авторозмір для всіх стовпців
        worksheet.columns.forEach(column => {
            if (column.width > 10) {
                const maxLength = worksheet.getColumn(column.key).values
                    .filter(value => value !== null)
                    .map(value => String(value).length)
                    .reduce((max, length) => Math.max(max, length), 0);
                column.width = Math.min(maxLength + 2, column.width);
            }
        });

        // Створюємо буфер для файлу
        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;
    }
}

module.exports = PaymentService;