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
            case 'created_by':
                orderByField = 'created_by_name';
                break;
            default:
                orderByField = 'p.payment_date';
        }
    
        // Обробка опції "всі записи" для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        // Модифікований запит з додаванням інформації про користувача
        let query = `
            SELECT 
                p.*,
                c.name as client_name,
                u.email as created_by_email,
                COALESCE(u.first_name || ' ' || u.last_name, u.email) as created_by_name
            FROM billing.payments p
            JOIN clients.clients c ON p.client_id = c.id
            LEFT JOIN auth.users u ON p.created_by = u.id
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
                u.email as created_by_email,
                COALESCE(u.first_name || ' ' || u.last_name, u.email) as created_by_name,
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
            LEFT JOIN auth.users u ON p.created_by = u.id
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
                invoice_id, notes, object_payments = [] 
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
    
            // Сценарій 1 і 2: Обробка рахунку, якщо він вказаний
            if (invoice_id) {
                // Отримуємо рахунок і його позиції
                const invoiceQuery = `
                    SELECT i.*, 
                           i.billing_month as invoice_month, 
                           i.billing_year as invoice_year 
                    FROM services.invoices i 
                    WHERE i.id = $1
                `;
                const invoiceResult = await client.query(invoiceQuery, [invoice_id]);
                
                if (invoiceResult.rows.length === 0) {
                    throw new Error('Вказаний рахунок не знайдено');
                }
                
                const invoice = invoiceResult.rows[0];
                
                // Змінюємо статус рахунку на "оплачено"
                await client.query(
                    `UPDATE services.invoices 
                     SET status = 'paid', payment_id = $1, updated_at = $2
                     WHERE id = $3`,
                    [paymentId, new Date(), invoice_id]
                );
                
                // Отримуємо позиції рахунку
                const itemsQuery = `
                    SELECT ii.*, s.service_type 
                    FROM services.invoice_items ii
                    JOIN services.services s ON ii.service_id = s.id
                    WHERE ii.invoice_id = $1
                `;
                const itemsResult = await client.query(itemsQuery, [invoice_id]);
                
                // Обробляємо кожну позицію рахунку
                for (const item of itemsResult.rows) {
                    // Перевіряємо, чи є це позиція з object_based послугою
                    if (item.service_type === 'object_based' && item.metadata && item.metadata.objects) {
                        // Для кожного об'єкта створюємо запис оплати
                        for (const obj of item.metadata.objects) {
                            await client.query(
                                `INSERT INTO billing.object_payment_records (
                                    object_id, payment_id, tariff_id, amount,
                                    billing_month, billing_year, status
                                )
                                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                [
                                    obj.id,
                                    paymentId,
                                    obj.tariff_id,
                                    obj.price,
                                    invoice.invoice_month,
                                    invoice.invoice_year,
                                    'paid'
                                ]
                            );
                        }
                    }
                    
                    // Якщо це запис про заборгованість, обробляємо його
                    if (item.metadata && item.metadata.is_debt && item.metadata.unpaid_invoices) {
                        for (const unpaidInvoice of item.metadata.unpaid_invoices) {
                            // Отримуємо позиції неоплаченого рахунку
                            const unpaidItemsQuery = `
                                SELECT ii.*, s.service_type 
                                FROM services.invoice_items ii
                                JOIN services.services s ON ii.service_id = s.id
                                WHERE ii.invoice_id = $1 AND s.service_type = 'object_based'
                            `;
                            const unpaidItemsResult = await client.query(unpaidItemsQuery, [unpaidInvoice.id]);
                            
                            // Обробляємо кожну позицію
                            for (const unpaidItem of unpaidItemsResult.rows) {
                                if (unpaidItem.metadata && unpaidItem.metadata.objects) {
                                    for (const obj of unpaidItem.metadata.objects) {
                                        await client.query(
                                            `INSERT INTO billing.object_payment_records (
                                                object_id, payment_id, tariff_id, amount,
                                                billing_month, billing_year, status
                                            )
                                            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                            [
                                                obj.id,
                                                paymentId,
                                                obj.tariff_id,
                                                obj.price,
                                                unpaidInvoice.billing_month,
                                                unpaidInvoice.billing_year,
                                                'paid'
                                            ]
                                        );
                                    }
                                }
                            }
                            
                            // Змінюємо статус неоплаченого рахунку
                            await client.query(
                                `UPDATE services.invoices 
                                SET status = 'paid', payment_id = $1, updated_at = $2
                                WHERE id = $3`,
                                [paymentId, new Date(), unpaidInvoice.id]
                            );
                        }
                    }
                }
            } 
            // Сценарій 3: Прямі оплати за об'єкти без рахунку
            else if (object_payments && object_payments.length > 0) {
                // Обробляємо кожен обраний об'єкт з UI
                for (const objPayment of object_payments) {
                    if (!objPayment.object_id || !objPayment.tariff_id) {
                        console.warn('Пропускаємо об\'єкт без ID або тарифу:', objPayment);
                        continue;
                    }
                    
                    // Перевіряємо активність об'єкта
                    const objectStatusResult = await client.query(
                        `SELECT status FROM wialon.objects WHERE id = $1`,
                        [objPayment.object_id]
                    );
                    
                    if (objectStatusResult.rows.length === 0 || objectStatusResult.rows[0].status !== 'active') {
                        console.warn(`Об'єкт ${objPayment.object_id} не активний або не знайдений. Оплата не буде створена.`);
                        continue;
                    }
    
// Отримуємо інформацію про тариф, якщо сума не вказана
                    let objAmount = objPayment.amount;
                    let actualTariffId = objPayment.tariff_id;
                    
                    if (!objAmount) {
                        // Визначаємо період оплати
                        const billingMonth = objPayment.billing_month || paymentMonth;
                        const billingYear = objPayment.billing_year || paymentYear;
                        
                        // Отримуємо останній тариф для цього місяця
                        const latestTariffResult = await client.query(
                            'SELECT * FROM billing.get_latest_tariff_for_month($1, $2, $3)',
                            [objPayment.object_id, billingYear, billingMonth]
                        );
                        
                        if (latestTariffResult.rows.length > 0) {
                            const latestTariff = latestTariffResult.rows[0];
                            objAmount = latestTariff.tariff_price;
                            actualTariffId = latestTariff.tariff_id;
                        } else if (objPayment.tariff_id) {
                            // Fallback до вказаного тарифу
                            const tariffQuery = `
                                SELECT price FROM billing.tariffs WHERE id = $1
                            `;
                            const tariffResult = await client.query(tariffQuery, [objPayment.tariff_id]);
                            if (tariffResult.rows.length > 0) {
                                objAmount = tariffResult.rows[0].price;
                            } else {
                                throw new Error(`Тариф з ID ${objPayment.tariff_id} не знайдено`);
                            }
                        } else {
                            throw new Error(`Не знайдено активний тариф для об'єкта ${objPayment.object_id} за період ${billingMonth}/${billingYear}`);
                        }
                    }                    
                    // Визначаємо період оплати (поточний, якщо не вказано)
                    const billingMonth = objPayment.billing_month || paymentMonth;
                    const billingYear = objPayment.billing_year || paymentYear;
                    
                    // Перевіряємо, чи період вже оплачений
                    const isPeriodPaidResult = await client.query(
                        `SELECT billing.is_period_paid($1, $2, $3) as is_paid`,
                        [objPayment.object_id, billingYear, billingMonth]
                    );
                    
                    if (isPeriodPaidResult.rows[0].is_paid) {
                        console.warn(`Період ${billingMonth}/${billingYear} для об'єкта ${objPayment.object_id} вже оплачений. Оплата не буде створена.`);
                        continue;
                    }
    
                    // Створюємо запис оплати для об'єкта за вказаний період
await client.query(
                        `INSERT INTO billing.object_payment_records (
                            object_id, payment_id, tariff_id, amount,
                            billing_month, billing_year, status
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            objPayment.object_id,
                            paymentId,
                            actualTariffId,
                            objAmount,
                            billingMonth,
                            billingYear,
                            objPayment.status || 'paid'
                        ]
                    );                }
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
    // Додати новий метод для отримання оплачених періодів об'єкта
static async getObjectPaidPeriods(objectId) {
    const query = `
        SELECT 
            opr.billing_month, 
            opr.billing_year,
            opr.status,
            p.payment_date,
            p.payment_type,
            opr.amount
        FROM billing.object_payment_records opr
        JOIN billing.payments p ON opr.payment_id = p.id
        WHERE opr.object_id = $1 AND opr.status IN ('paid', 'partial')
        ORDER BY opr.billing_year, opr.billing_month
    `;

    const result = await pool.query(query, [objectId]);
    return result.rows;
}

// Додати метод для перевірки чи період вже оплачений
static async isPeriodPaid(objectId, year, month) {
    const result = await pool.query(
        'SELECT billing.is_period_paid($1, $2, $3) as is_paid',
        [objectId, year, month]
    );
    return result.rows[0].is_paid;
}

// Додати метод для отримання наступного неоплаченого періоду
static async getNextUnpaidPeriod(objectId) {
    const result = await pool.query(
        'SELECT * FROM billing.get_next_unpaid_period($1)',
        [objectId]
    );
    
    if (result.rows.length === 0) {
        // Якщо функція не повернула результат, повертаємо поточний місяць
        const now = new Date();
        return {
            billing_year: now.getFullYear(),
            billing_month: now.getMonth() + 1
        };
    }
    
    return result.rows[0];
}


// Отримання об'єктів для клієнта з інформацією про оплачені періоди
static async getClientObjectsWithPayments(clientId, year = null, month = null) {
    // Якщо рік і місяць не вказані, використовуємо поточні
    if (!year || !month) {
        const now = new Date();
        year = year || now.getFullYear();
        month = month || now.getMonth() + 1;
    }

    const query = `
        SELECT 
            o.id, o.name, o.wialon_id, o.status,
            t.id as tariff_id, t.name as tariff_name, t.price as tariff_price,
            (SELECT billing.is_period_paid(o.id, $2, $3)) as is_period_paid,
            (
                SELECT jsonb_build_object(
                    'billing_month', np.billing_month,
                    'billing_year', np.billing_year
                )
                FROM billing.get_next_unpaid_period(o.id) np
                LIMIT 1
            ) as next_unpaid_period
        FROM wialon.objects o
        LEFT JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
        LEFT JOIN billing.tariffs t ON ot.tariff_id = t.id
        WHERE o.client_id = $1 AND o.status = 'active'
        ORDER BY o.name
    `;

    const result = await pool.query(query, [clientId, year, month]);
    return result.rows;
}

// Отримання доступних періодів для оплати для об'єкта
static async getAvailablePaymentPeriods(objectId, count = 12) {
    try {
        // Отримуємо дату призначення об'єкта клієнту
        const ownershipQuery = `
            SELECT 
                start_date
            FROM wialon.object_ownership_history
            WHERE object_id = $1
            ORDER BY start_date ASC
            LIMIT 1
        `;
        
        const ownershipResult = await pool.query(ownershipQuery, [objectId]);
        
        // Якщо немає інформації про власника, повертаємо пустий масив
        if (ownershipResult.rows.length === 0) {
            return { periods: [] };
        }
        
        const ownershipStartDate = new Date(ownershipResult.rows[0].start_date);
        
        // Отримуємо історію тарифів об'єкта
        const tariffHistoryQuery = `
            SELECT 
                ot.tariff_id, 
                t.name AS tariff_name, 
                t.price,
                ot.effective_from,
                ot.effective_to
            FROM billing.object_tariffs ot
            JOIN billing.tariffs t ON ot.tariff_id = t.id
            WHERE ot.object_id = $1
            ORDER BY ot.effective_from ASC
        `;
        
        const tariffHistoryResult = await pool.query(tariffHistoryQuery, [objectId]);
        
        // Якщо немає тарифів, повертаємо пустий масив
        if (tariffHistoryResult.rows.length === 0) {
            return { periods: [] };
        }
        
        // Отримуємо інформацію про оплачені періоди
        const paidPeriodsQuery = `
            SELECT 
                billing_month,
                billing_year
            FROM billing.object_payment_records
            WHERE object_id = $1 AND status IN ('paid', 'partial')
        `;
        
        const paidPeriodsResult = await pool.query(paidPeriodsQuery, [objectId]);
        const paidPeriods = paidPeriodsResult.rows;
        
        // Отримуємо інформацію про виставлені рахунки для об'єкта
        const invoicesQuery = `
            SELECT 
                i.billing_month,
                i.billing_year,
                i.id as invoice_id,
                i.invoice_number,
                i.status
            FROM services.invoices i
            JOIN services.invoice_items ii ON i.id = ii.invoice_id
            JOIN services.services s ON ii.service_id = s.id,
            jsonb_array_elements(ii.metadata->'objects') as obj_data
            WHERE obj_data->>'id' = $1
            AND s.service_type = 'object_based'
            AND i.status = 'issued'
        `;
        
        const invoicesResult = await pool.query(invoicesQuery, [objectId]);
        const existingInvoices = invoicesResult.rows;
        
        // Визначаємо початкову дату - це максимум з дати призначення і першого тарифу
        const firstTariffDate = new Date(tariffHistoryResult.rows[0].effective_from);
        const startDate = new Date(Math.max(ownershipStartDate.getTime(), firstTariffDate.getTime()));
        
        // Встановлюємо на 1 число місяця
        startDate.setDate(1);
        
        // Визначаємо кінцеву дату для майбутніх періодів
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 6); // 6 місяців вперед
        endDate.setDate(1); // Перше число місяця
        
        // Поточна дата
        const currentDate = new Date();
        
        // Генеруємо всі місяці від startDate до endDate
        const allPeriods = [];
        const iterDate = new Date(startDate);
        
        // Проходимо по всіх місяцях від startDate до endDate
        while (iterDate <= endDate) {
            const year = iterDate.getFullYear();
            const month = iterDate.getMonth() + 1; // Місяці в JS починаються з 0
            
// Отримуємо останній тариф для цього періоду через нову функцію
            let activeTariff = null;
            try {
                const latestTariffResult = await pool.query(
                    'SELECT * FROM billing.get_latest_tariff_for_month($1, $2, $3)',
                    [objectId, year, month]
                );
                
                if (latestTariffResult.rows.length > 0) {
                    const latestTariff = latestTariffResult.rows[0];
                    // Шукаємо відповідний тариф в історії для отримання назви
                    const tariffWithName = tariffHistoryResult.rows.find(t => t.tariff_id === latestTariff.tariff_id);
                    
                    activeTariff = {
                        tariff_id: latestTariff.tariff_id,
                        tariff_name: tariffWithName ? tariffWithName.tariff_name : 'Невідомий тариф',
                        price: latestTariff.tariff_price
                    };
                }
            } catch (error) {
                console.error(`Помилка отримання тарифу для періоду ${month}/${year}:`, error);
                // Fallback до старої логіки
                activeTariff = tariffHistoryResult.rows.find(tariff => {
                    const effectiveFrom = new Date(tariff.effective_from);
                    const effectiveTo = tariff.effective_to ? new Date(tariff.effective_to) : new Date(9999, 11, 31);
                    
                    const periodDate = new Date(year, month - 1, 1);
                    
                    return effectiveFrom <= periodDate && periodDate <= effectiveTo;
                });
            }
            
            // Додаємо період, тільки якщо є активний тариф
            if (activeTariff) {
                // Перевіряємо, чи період оплачений
                const isPaid = paidPeriods.some(period => 
                    period.billing_year == year && period.billing_month == month
                );
                
                // Перевіряємо, чи є виставлений рахунок за цей період
                const existingInvoice = existingInvoices.find(invoice =>
                    invoice.billing_year == year && invoice.billing_month == month
                );
                
                // Додаємо період, якщо він не оплачений
                if (!isPaid) {
                    allPeriods.push({
                        billing_year: year,
                        billing_month: month,
                        tariff_id: activeTariff.tariff_id,
                        tariff_name: activeTariff.tariff_name,
                        price: activeTariff.price,
                        is_paid: false,
                        has_invoice: !!existingInvoice,
                        invoice_id: existingInvoice ? existingInvoice.invoice_id : null,
                        invoice_number: existingInvoice ? existingInvoice.invoice_number : null
                    });
                }
            }
            
            // Переходимо до наступного місяця
            iterDate.setMonth(iterDate.getMonth() + 1);
        }
        
        // Сортуємо періоди (спершу найстаріші)
        allPeriods.sort((a, b) => {
            if (a.billing_year !== b.billing_year) {
                return a.billing_year - b.billing_year;
            }
            return a.billing_month - b.billing_month;
        });
        
        // Обмежуємо кількість періодів до заданого count
        const limitedPeriods = count ? allPeriods.slice(0, count) : allPeriods;
        
        return { periods: limitedPeriods };
    } catch (error) {
        console.error('Error getting available payment periods:', error);
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

// Отримання метрик прострочених платежів
static async getOverdueMetrics() {
    try {
        // Запит для загальної суми прострочених платежів за об'єкти
        const objectsOverdueQuery = `
            WITH object_start_dates AS (
                -- Отримуємо для кожного об'єкта дату призначення клієнту або встановлення тарифу (що пізніше)
                SELECT 
                    o.id as object_id,
                    GREATEST(
                        COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                        COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                    ) as start_date
                FROM wialon.objects o
                WHERE o.status = 'active'
            ),
            all_periods AS (
                -- Генеруємо всі періоди для кожного об'єкта
                SELECT 
                    o.id as object_id,
                    period_date
                FROM wialon.objects o
                JOIN object_start_dates osd ON o.id = osd.object_id,
                LATERAL (
                    SELECT generate_series(
                        GREATEST(
                            date_trunc('month', osd.start_date), 
                            date_trunc('year', current_date)
                        ), 
                        date_trunc('month', current_date),
                        interval '1 month'
                    ) as period_date
                ) dates
                WHERE o.status = 'active'
                AND period_date >= date_trunc('month', osd.start_date)
            ),
            period_tariffs AS (
                -- Для кожного періоду знаходимо всі тарифи що діяли в цьому місяці
                SELECT 
                    ap.object_id,
                    ap.period_date,
                    ot.tariff_id,
                    t.price,
                    -- Рахуємо кількість днів в місяці для кожного тарифу
                    EXTRACT(days FROM 
                        LEAST(
                            ap.period_date + interval '1 month',
                            COALESCE(ot.effective_to, '9999-12-31'::date)
                        ) - GREATEST(
                            ap.period_date,
                            ot.effective_from::date
                        )
                    ) as days_count
                FROM all_periods ap
                JOIN billing.object_tariffs ot ON ap.object_id = ot.object_id
                JOIN billing.tariffs t ON ot.tariff_id = t.id
                WHERE 
                    -- Тариф діяв в цьому періоді
                    ot.effective_from::date < ap.period_date + interval '1 month'
                    AND COALESCE(ot.effective_to, '9999-12-31'::date) > ap.period_date
            ),
            majority_tariffs AS (
                -- Вибираємо тариф з найбільшою кількістю днів для кожного періоду
                SELECT 
                    object_id,
                    period_date,
                    price,
                    ROW_NUMBER() OVER (
                        PARTITION BY object_id, period_date 
                        ORDER BY days_count DESC, tariff_id DESC
                    ) as rn
                FROM period_tariffs
                WHERE days_count > 0
            ),
            valid_periods AS (
                -- Періоди з тарифами більшості
                SELECT 
                    object_id,
                    period_date,
                    price
                FROM majority_tariffs
                WHERE rn = 1
            ),
            paid_periods AS (
                -- Всі оплачені періоди
                SELECT 
                    opr.object_id,
                    make_date(opr.billing_year, opr.billing_month, 1) as period_date
                FROM billing.object_payment_records opr
                WHERE opr.status IN ('paid', 'partial')
            )
            SELECT COALESCE(SUM(vp.price), 0) as total_amount
            FROM valid_periods vp
            WHERE NOT EXISTS (
                -- Перевіряємо, чи період оплачений
                SELECT 1 FROM paid_periods pp
                WHERE pp.object_id = vp.object_id AND pp.period_date = vp.period_date
            )
            AND vp.period_date < date_trunc('month', current_date + interval '1 month')
        `;

        // Новий запит для суми прострочених фіксованих послуг
        const fixedServicesOverdueQuery = `
            WITH fixed_invoices AS (
                -- Отримуємо неоплачені рахунки з послугами фіксованого типу
                SELECT 
                    i.id,
                    i.client_id,
                    i.total_amount,
                    i.billing_month,
                    i.billing_year,
                    make_date(i.billing_year, i.billing_month, 1) as billing_date
                FROM services.invoices i
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                WHERE i.status = 'issued'  -- тільки неоплачені рахунки
                AND s.service_type = 'fixed'
                AND make_date(i.billing_year, i.billing_month, 1) < date_trunc('month', current_date + interval '1 month')
                GROUP BY i.id, i.client_id, i.total_amount, i.billing_month, i.billing_year
            )
            SELECT COALESCE(SUM(total_amount), 0) as total_amount
            FROM fixed_invoices
        `;

        // Кількість клієнтів з об'єктами, що мають прострочені платежі
        const objectClientsCountQuery = `
            WITH object_start_dates AS (
                SELECT 
                    o.id as object_id,
                    GREATEST(
                        COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                        COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                    ) as start_date
                FROM wialon.objects o
                WHERE o.status = 'active'
            ),
            all_periods AS (
                SELECT 
                    o.id as object_id,
                    o.client_id,
                    period_date
                FROM wialon.objects o
                JOIN object_start_dates osd ON o.id = osd.object_id,
                LATERAL (
                    SELECT generate_series(
                        GREATEST(
                            date_trunc('month', osd.start_date), 
                            date_trunc('year', current_date)
                        ), 
                        date_trunc('month', current_date),
                        interval '1 month'
                    ) as period_date
                ) dates
                WHERE o.status = 'active'
                AND period_date >= date_trunc('month', osd.start_date)
            ),
            period_tariffs AS (
                SELECT 
                    ap.object_id,
                    ap.client_id,
                    ap.period_date,
                    ot.tariff_id,
                    t.price,
                    EXTRACT(days FROM 
                        LEAST(
                            ap.period_date + interval '1 month',
                            COALESCE(ot.effective_to, '9999-12-31'::date)
                        ) - GREATEST(
                            ap.period_date,
                            ot.effective_from::date
                        )
                    ) as days_count
                FROM all_periods ap
                JOIN billing.object_tariffs ot ON ap.object_id = ot.object_id
                JOIN billing.tariffs t ON ot.tariff_id = t.id
                WHERE 
                    ot.effective_from::date < ap.period_date + interval '1 month'
                    AND COALESCE(ot.effective_to, '9999-12-31'::date) > ap.period_date
            ),
            majority_tariffs AS (
                SELECT 
                    object_id,
                    client_id,
                    period_date,
                    price,
                    ROW_NUMBER() OVER (
                        PARTITION BY object_id, period_date 
                        ORDER BY days_count DESC, tariff_id DESC
                    ) as rn
                FROM period_tariffs
                WHERE days_count > 0
            ),
            valid_periods AS (
                SELECT 
                    object_id,
                    client_id,
                    period_date,
                    price
                FROM majority_tariffs
                WHERE rn = 1
            ),
            paid_periods AS (
                SELECT 
                    opr.object_id,
                    make_date(opr.billing_year, opr.billing_month, 1) as period_date
                FROM billing.object_payment_records opr
                WHERE opr.status IN ('paid', 'partial')
            ),
            clients_with_objects_overdue AS (
                SELECT DISTINCT vp.client_id
                FROM valid_periods vp
                WHERE NOT EXISTS (
                    SELECT 1 FROM paid_periods pp
                    WHERE pp.object_id = vp.object_id AND pp.period_date = vp.period_date
                )
                AND vp.period_date < date_trunc('month', current_date + interval '1 month')
            )
            SELECT COUNT(*) as clients_count
            FROM clients_with_objects_overdue
        `;

        // Новий запит для кількості клієнтів з простроченими фіксованими послугами
        const fixedClientsCountQuery = `
            WITH fixed_services_clients AS (
                SELECT DISTINCT i.client_id
                FROM services.invoices i
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                WHERE i.status = 'issued'  -- тільки неоплачені рахунки
                AND s.service_type = 'fixed'
                AND make_date(i.billing_year, i.billing_month, 1) < date_trunc('month', current_date + interval '1 month')
            )
            SELECT COUNT(*) as clients_count
            FROM fixed_services_clients
        `;

        // Загальна кількість клієнтів з простроченими оплатами (об'єкти або фіксовані послуги)
        const totalClientsCountQuery = `
            WITH objects_overdue_clients AS (
                -- Клієнти з простроченими платежами за об'єкти (з логікою більшості днів)
                WITH object_start_dates AS (
                    SELECT 
                        o.id as object_id,
                        GREATEST(
                            COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                            COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                        ) as start_date
                    FROM wialon.objects o
                    WHERE o.status = 'active'
                ),
                all_periods AS (
                    SELECT 
                        o.id as object_id,
                        o.client_id,
                        period_date
                    FROM wialon.objects o
                    JOIN object_start_dates osd ON o.id = osd.object_id,
                    LATERAL (
                        SELECT generate_series(
                            GREATEST(
                                date_trunc('month', osd.start_date), 
                                date_trunc('year', current_date)
                            ), 
                            date_trunc('month', current_date),
                            interval '1 month'
                        ) as period_date
                    ) dates
                    WHERE o.status = 'active'
                    AND period_date >= date_trunc('month', osd.start_date)
                ),
                period_tariffs AS (
                    SELECT 
                        ap.object_id,
                        ap.client_id,
                        ap.period_date,
                        ot.tariff_id,
                        t.price,
                        EXTRACT(days FROM 
                            LEAST(
                                ap.period_date + interval '1 month',
                                COALESCE(ot.effective_to, '9999-12-31'::date)
                            ) - GREATEST(
                                ap.period_date,
                                ot.effective_from::date
                            )
                        ) as days_count
                    FROM all_periods ap
                    JOIN billing.object_tariffs ot ON ap.object_id = ot.object_id
                    JOIN billing.tariffs t ON ot.tariff_id = t.id
                    WHERE 
                        ot.effective_from::date < ap.period_date + interval '1 month'
                        AND COALESCE(ot.effective_to, '9999-12-31'::date) > ap.period_date
                ),
                majority_tariffs AS (
                    SELECT 
                        object_id,
                        client_id,
                        period_date,
                        price,
                        ROW_NUMBER() OVER (
                            PARTITION BY object_id, period_date 
                            ORDER BY days_count DESC, tariff_id DESC
                        ) as rn
                    FROM period_tariffs
                    WHERE days_count > 0
                ),
                valid_periods AS (
                    SELECT 
                        object_id,
                        client_id,
                        period_date,
                        price
                    FROM majority_tariffs
                    WHERE rn = 1
                ),
                paid_periods AS (
                    SELECT 
                        opr.object_id,
                        make_date(opr.billing_year, opr.billing_month, 1) as period_date
                    FROM billing.object_payment_records opr
                    WHERE opr.status IN ('paid', 'partial')
                )
                SELECT DISTINCT vp.client_id
                FROM valid_periods vp
                WHERE NOT EXISTS (
                    SELECT 1 FROM paid_periods pp
                    WHERE pp.object_id = vp.object_id AND pp.period_date = vp.period_date
                )
                AND vp.period_date < date_trunc('month', current_date + interval '1 month')
            ),
            fixed_overdue_clients AS (
                -- Клієнти з простроченими платежами за фіксовані послуги
                SELECT DISTINCT i.client_id
                FROM services.invoices i
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                WHERE i.status = 'issued'
                AND s.service_type = 'fixed'
                AND make_date(i.billing_year, i.billing_month, 1) < date_trunc('month', current_date + interval '1 month')
            )
            SELECT COUNT(DISTINCT client_id) as total_clients_count
            FROM (
                SELECT client_id FROM objects_overdue_clients
                UNION
                SELECT client_id FROM fixed_overdue_clients
            ) as all_clients
        `;

        // Кількість об'єктів з простроченими платежами
        const objectsCountQuery = `
            WITH object_start_dates AS (
                SELECT 
                    o.id as object_id,
                    GREATEST(
                        COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                        COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                    ) as start_date
                FROM wialon.objects o
                WHERE o.status = 'active'
            ),
            all_periods AS (
                SELECT 
                    o.id as object_id,
                    period_date
                FROM wialon.objects o
                JOIN object_start_dates osd ON o.id = osd.object_id,
                LATERAL (
                    SELECT generate_series(
                        GREATEST(
                            date_trunc('month', osd.start_date), 
                            date_trunc('year', current_date)
                        ), 
                        date_trunc('month', current_date),
                        interval '1 month'
                    ) as period_date
                ) dates
                WHERE o.status = 'active'
                AND period_date >= date_trunc('month', osd.start_date)
            ),
            period_tariffs AS (
                SELECT 
                    ap.object_id,
                    ap.period_date,
                    ot.tariff_id,
                    t.price,
                    EXTRACT(days FROM 
                        LEAST(
                            ap.period_date + interval '1 month',
                            COALESCE(ot.effective_to, '9999-12-31'::date)
                        ) - GREATEST(
                            ap.period_date,
                            ot.effective_from::date
                        )
                    ) as days_count
                FROM all_periods ap
                JOIN billing.object_tariffs ot ON ap.object_id = ot.object_id
                JOIN billing.tariffs t ON ot.tariff_id = t.id
                WHERE 
                    ot.effective_from::date < ap.period_date + interval '1 month'
                    AND COALESCE(ot.effective_to, '9999-12-31'::date) > ap.period_date
            ),
            majority_tariffs AS (
                SELECT 
                    object_id,
                    period_date,
                    price,
                    ROW_NUMBER() OVER (
                        PARTITION BY object_id, period_date 
                        ORDER BY days_count DESC, tariff_id DESC
                    ) as rn
                FROM period_tariffs
                WHERE days_count > 0
            ),
            valid_periods AS (
                SELECT 
                    object_id,
                    period_date,
                    price
                FROM majority_tariffs
                WHERE rn = 1
            ),
            paid_periods AS (
                SELECT 
                    opr.object_id,
                    make_date(opr.billing_year, opr.billing_month, 1) as period_date
                FROM billing.object_payment_records opr
                WHERE opr.status IN ('paid', 'partial')
            ),
            objects_with_overdue AS (
                SELECT DISTINCT vp.object_id
                FROM valid_periods vp
                WHERE NOT EXISTS (
                    SELECT 1 FROM paid_periods pp
                    WHERE pp.object_id = vp.object_id AND pp.period_date = vp.period_date
                )
                AND vp.period_date < date_trunc('month', current_date + interval '1 month')
            )
            SELECT COUNT(*) as objects_count
            FROM objects_with_overdue
        `;

        // Оновлений запит для відсотка оплачених періодів, включаючи фіксовані послуги
        const paymentRateQuery = `
            WITH all_periods AS (
                -- Всі періоди, які мають бути оплачені (об'єкти та фіксовані послуги)
                -- Періоди для об'єктів з логікою більшості днів
                WITH object_start_dates AS (
                    SELECT 
                        o.id as object_id,
                        GREATEST(
                            COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                            COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                        ) as start_date
                    FROM wialon.objects o
                    WHERE o.status = 'active'
                ),
                object_periods AS (
                    SELECT 
                        o.id as object_id,
                        period_date
                    FROM wialon.objects o
                    JOIN object_start_dates osd ON o.id = osd.object_id,
                    LATERAL (
                        SELECT generate_series(
                            GREATEST(
                                date_trunc('month', osd.start_date), 
                                date_trunc('year', current_date)
                            ), 
                            date_trunc('month', current_date),
                            interval '1 month'
                        ) as period_date
                    ) dates
                    WHERE o.status = 'active'
                    AND period_date >= date_trunc('month', osd.start_date)
                ),
                object_period_tariffs AS (
                    SELECT 
                        op.object_id,
                        op.period_date,
                        ot.tariff_id,
                        t.price,
                        EXTRACT(days FROM 
                            LEAST(
                                op.period_date + interval '1 month',
                                COALESCE(ot.effective_to, '9999-12-31'::date)
                            ) - GREATEST(
                                op.period_date,
                                ot.effective_from::date
                            )
                        ) as days_count
                    FROM object_periods op
                    JOIN billing.object_tariffs ot ON op.object_id = ot.object_id
                    JOIN billing.tariffs t ON ot.tariff_id = t.id
                    WHERE 
                        ot.effective_from::date < op.period_date + interval '1 month'
                        AND COALESCE(ot.effective_to, '9999-12-31'::date) > op.period_date
                ),
                object_majority_tariffs AS (
                    SELECT 
                        object_id,
                        period_date,
                        price,
                        ROW_NUMBER() OVER (
                            PARTITION BY object_id, period_date 
                            ORDER BY days_count DESC, tariff_id DESC
                        ) as rn
                    FROM object_period_tariffs
                    WHERE days_count > 0
                )
                SELECT 'object' as type, object_id as entity_id, period_date
                FROM object_majority_tariffs
                WHERE rn = 1
                
                UNION ALL
                
                -- Періоди для фіксованих послуг
                SELECT 'fixed' as type, i.id as entity_id, make_date(i.billing_year, i.billing_month, 1) as period_date
                FROM services.invoices i
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                WHERE s.service_type = 'fixed'
                AND make_date(i.billing_year, i.billing_month, 1) <= date_trunc('month', current_date)
            ),
            paid_periods AS (
                -- Оплачені періоди для об'єктів
                SELECT 'object' as type, opr.object_id as entity_id, make_date(opr.billing_year, opr.billing_month, 1) as period_date
                FROM billing.object_payment_records opr
                WHERE opr.status IN ('paid', 'partial')
                
                UNION ALL
                
                -- Оплачені рахунки для фіксованих послуг
                SELECT 'fixed' as type, i.id as entity_id, make_date(i.billing_year, i.billing_month, 1) as period_date
                FROM services.invoices i
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                WHERE i.status = 'paid'
                AND s.service_type = 'fixed'
            ),
            period_stats AS (
                SELECT 
                    COUNT(*) as total_periods,
                    (
                        SELECT COUNT(*)
                        FROM all_periods ap
                        WHERE EXISTS (
                            SELECT 1 FROM paid_periods pp
                            WHERE pp.type = ap.type 
                            AND pp.entity_id = ap.entity_id 
                            AND pp.period_date = ap.period_date
                        )
                    ) as paid_periods
                FROM all_periods
            )
            SELECT 
                CASE 
                    WHEN total_periods = 0 THEN 100
                    ELSE ROUND(paid_periods * 100.0 / total_periods)
                END as payment_rate
            FROM period_stats
        `;

        // Виконання всіх запитів паралельно
        const [
            objectsOverdueResult, 
            fixedOverdueResult, 
            objectClientsResult, 
            fixedClientsResult, 
            totalClientsResult,
            objectsCountResult, 
            paymentRateResult
        ] = await Promise.all([
            pool.query(objectsOverdueQuery),
            pool.query(fixedServicesOverdueQuery),
            pool.query(objectClientsCountQuery),
            pool.query(fixedClientsCountQuery),
            pool.query(totalClientsCountQuery),
            pool.query(objectsCountQuery),
            pool.query(paymentRateQuery)
        ]);

        // Обчислення загальної суми заборгованості
        const objectsOverdueAmount = parseFloat(objectsOverdueResult.rows[0].total_amount || 0);
        const fixedOverdueAmount = parseFloat(fixedOverdueResult.rows[0].total_amount || 0);
        const totalOverdueAmount = objectsOverdueAmount + fixedOverdueAmount;

        return {
            totalAmount: totalOverdueAmount,
            clientsCount: parseInt(totalClientsResult.rows[0].total_clients_count || 0),
            objectsCount: parseInt(objectsCountResult.rows[0].objects_count || 0),
            objectsOverdueAmount: objectsOverdueAmount,
            fixedServicesOverdueAmount: fixedOverdueAmount,
            objectClientsCount: parseInt(objectClientsResult.rows[0].clients_count || 0),
            fixedClientsCount: parseInt(fixedClientsResult.rows[0].clients_count || 0),
            paymentRate: parseInt(paymentRateResult.rows[0].payment_rate || 0)
        };
    } catch (error) {
        console.error('Error getting overdue metrics:', error);
        throw error;
    }
}

// Отримання клієнтів з простроченими платежами
static async getOverdueClients() {
    try {
        const query = `
            WITH objects_overdue_clients AS (
                -- Клієнти з простроченими платежами за об'єкти з логікою більшості днів
                WITH object_start_dates AS (
                    SELECT 
                        o.id as object_id,
                        GREATEST(
                            COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                            COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                        ) as start_date
                    FROM wialon.objects o
                    WHERE o.status = 'active'
                ),
                all_periods AS (
                    SELECT 
                        o.id as object_id,
                        o.client_id,
                        c.name as client_name,
                        period_date
                    FROM wialon.objects o
                    JOIN clients.clients c ON o.client_id = c.id
                    JOIN object_start_dates osd ON o.id = osd.object_id,
                    LATERAL (
                        SELECT generate_series(
                            GREATEST(
                                date_trunc('month', osd.start_date), 
                                date_trunc('year', current_date)
                            ), 
                            date_trunc('month', current_date),
                            interval '1 month'
                        ) as period_date
                    ) dates
                    WHERE o.status = 'active'
                    AND period_date >= date_trunc('month', osd.start_date)
                ),
                period_tariffs AS (
                    SELECT 
                        ap.object_id,
                        ap.client_id,
                        ap.client_name,
                        ap.period_date,
                        ot.tariff_id,
                        t.price,
                        EXTRACT(days FROM 
                            LEAST(
                                ap.period_date + interval '1 month',
                                COALESCE(ot.effective_to, '9999-12-31'::date)
                            ) - GREATEST(
                                ap.period_date,
                                ot.effective_from::date
                            )
                        ) as days_count
                    FROM all_periods ap
                    JOIN billing.object_tariffs ot ON ap.object_id = ot.object_id
                    JOIN billing.tariffs t ON ot.tariff_id = t.id
                    WHERE 
                        ot.effective_from::date < ap.period_date + interval '1 month'
                        AND COALESCE(ot.effective_to, '9999-12-31'::date) > ap.period_date
                ),
                majority_tariffs AS (
                    SELECT 
                        object_id,
                        client_id,
                        client_name,
                        period_date,
                        price,
                        ROW_NUMBER() OVER (
                            PARTITION BY object_id, period_date 
                            ORDER BY days_count DESC, tariff_id DESC
                        ) as rn
                    FROM period_tariffs
                    WHERE days_count > 0
                ),
                valid_periods AS (
                    SELECT 
                        object_id,
                        client_id,
                        client_name,
                        period_date,
                        price
                    FROM majority_tariffs
                    WHERE rn = 1
                ),
                paid_periods AS (
                    SELECT 
                        opr.object_id,
                        make_date(opr.billing_year, opr.billing_month, 1) as period_date
                    FROM billing.object_payment_records opr
                    WHERE opr.status IN ('paid', 'partial')
                ),
                objects_overdue AS (
                    SELECT 
                        vp.client_id,
                        vp.client_name,
                        vp.object_id,
                        SUM(vp.price) as total_overdue
                    FROM valid_periods vp
                    WHERE NOT EXISTS (
                        SELECT 1 FROM paid_periods pp
                        WHERE pp.object_id = vp.object_id AND pp.period_date = vp.period_date
                    )
                    AND vp.period_date < date_trunc('month', current_date + interval '1 month')
                    GROUP BY vp.client_id, vp.client_name, vp.object_id
                )
                SELECT 
                    oo.client_id,
                    oo.client_name,
                    COUNT(DISTINCT oo.object_id) as objects_count,
                    SUM(oo.total_overdue) as objects_overdue
                FROM objects_overdue oo
                GROUP BY oo.client_id, oo.client_name
            ),
            fixed_services_overdue_clients AS (
                -- Клієнти з простроченими платежами за фіксовані послуги
                SELECT 
                    c.id as client_id,
                    c.name as client_name,
                    COUNT(DISTINCT i.id) as invoices_count,
                    SUM(i.total_amount) as fixed_overdue
                FROM services.invoices i
                JOIN clients.clients c ON i.client_id = c.id
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                WHERE i.status = 'issued'
                AND s.service_type = 'fixed'
                AND make_date(i.billing_year, i.billing_month, 1) < date_trunc('month', current_date + interval '1 month')
                GROUP BY c.id, c.name
            ),
            combined_overdue AS (
                -- Об'єднання заборгованостей за об'єкти та фіксовані послуги
                SELECT 
                    COALESCE(o.client_id, f.client_id) as id,
                    COALESCE(o.client_name, f.client_name) as name,
                    COALESCE(o.objects_count, 0) as "objectsCount",
                    COALESCE(f.invoices_count, 0) as "invoicesCount",
                    COALESCE(o.objects_overdue, 0) as "objectsOverdue",
                    COALESCE(f.fixed_overdue, 0) as "fixedOverdue",
                    COALESCE(o.objects_overdue, 0) + COALESCE(f.fixed_overdue, 0) as "totalOverdue"
                FROM objects_overdue_clients o
                FULL OUTER JOIN fixed_services_overdue_clients f ON o.client_id = f.client_id
            )
            SELECT *
            FROM combined_overdue
            WHERE "totalOverdue" > 0
            ORDER BY "totalOverdue" DESC
            LIMIT 20
        `;

        const result = await pool.query(query);
        return result.rows;
    } catch (error) {
        console.error('Error getting overdue clients:', error);
        throw error;
    }
}

// Отримання об'єктів та фіксованих послуг з простроченими платежами
// У файлі paymentService.js

// Отримання об'єктів та фіксованих послуг з простроченими платежами
static async getOverdueObjects() {
    try {
        const query = `
            WITH objects_overdue AS (
                -- Об'єкти з простроченими платежами з логікою більшості днів
                WITH object_start_dates AS (
                    SELECT 
                        o.id as object_id,
                        GREATEST(
                            COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                            COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                        ) as start_date
                    FROM wialon.objects o
                    WHERE o.status = 'active'
                ),
                all_periods AS (
                    SELECT 
                        o.id as object_id,
                        o.name as object_name,
                        o.client_id,
                        c.name as client_name,
                        period_date
                    FROM wialon.objects o
                    JOIN clients.clients c ON o.client_id = c.id
                    JOIN object_start_dates osd ON o.id = osd.object_id,
                    LATERAL (
                        SELECT generate_series(
                            GREATEST(
                                date_trunc('month', osd.start_date), 
                                date_trunc('year', current_date)
                            ), 
                            date_trunc('month', current_date),
                            interval '1 month'
                        ) as period_date
                    ) dates
                    WHERE o.status = 'active'
                    AND period_date >= date_trunc('month', osd.start_date)
                ),
                period_tariffs AS (
                    SELECT 
                        ap.object_id,
                        ap.object_name,
                        ap.client_id,
                        ap.client_name,
                        ap.period_date,
                        ot.tariff_id,
                        t.price as amount,
                        EXTRACT(days FROM 
                            LEAST(
                                ap.period_date + interval '1 month',
                                COALESCE(ot.effective_to, '9999-12-31'::date)
                            ) - GREATEST(
                                ap.period_date,
                                ot.effective_from::date
                            )
                        ) as days_count
                    FROM all_periods ap
                    JOIN billing.object_tariffs ot ON ap.object_id = ot.object_id
                    JOIN billing.tariffs t ON ot.tariff_id = t.id
                    WHERE 
                        -- Тариф діяв в цьому періоді
                        ot.effective_from::date < ap.period_date + interval '1 month'
                        AND COALESCE(ot.effective_to, '9999-12-31'::date) > ap.period_date
                ),
                majority_tariffs AS (
                    SELECT 
                        object_id,
                        object_name,
                        client_id,
                        client_name,
                        period_date,
                        amount,
                        ROW_NUMBER() OVER (
                            PARTITION BY object_id, period_date 
                            ORDER BY days_count DESC, tariff_id DESC
                        ) as rn
                    FROM period_tariffs
                    WHERE days_count > 0
                ),
                valid_periods AS (
                    SELECT 
                        object_id,
                        object_name,
                        client_id,
                        client_name,
                        period_date,
                        amount,
                        EXTRACT(month FROM period_date) as billing_month,
                        EXTRACT(year FROM period_date) as billing_year,
                        'object' as item_type
                    FROM majority_tariffs
                    WHERE rn = 1
                ),
                paid_periods AS (
                    SELECT 
                        opr.object_id,
                        make_date(opr.billing_year, opr.billing_month, 1) as period_date
                    FROM billing.object_payment_records opr
                    WHERE opr.status IN ('paid', 'partial')
                )
                SELECT 
                    vp.object_id as id,
                    vp.object_name as name,
                    vp.client_id,
                    vp.client_name,
                    vp.billing_month::int,
                    vp.billing_year::int,
                    vp.amount,
                    vp.period_date,
                    vp.item_type
                FROM valid_periods vp
                WHERE NOT EXISTS (
                    SELECT 1 FROM paid_periods pp
                    WHERE pp.object_id = vp.object_id AND pp.period_date = vp.period_date
                )
                AND vp.period_date < date_trunc('month', current_date + interval '1 month')
            ),
            fixed_services_overdue AS (
                -- Рахунки з простроченими фіксованими послугами
                SELECT 
                    i.id,
                    s.name,
                    i.client_id,
                    c.name as client_name,
                    i.billing_month::int,
                    i.billing_year::int,
                    ii.unit_price as amount,
                    make_date(i.billing_year, i.billing_month, 1) as period_date,
                    'fixed' as item_type
                FROM services.invoices i
                JOIN clients.clients c ON i.client_id = c.id
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                WHERE i.status = 'issued'
                AND s.service_type = 'fixed'
                AND make_date(i.billing_year, i.billing_month, 1) < date_trunc('month', current_date + interval '1 month')
            )
            SELECT * FROM (
                SELECT * FROM objects_overdue
                UNION ALL
                SELECT * FROM fixed_services_overdue
            ) as combined_overdue
            ORDER BY period_date ASC, amount DESC
            LIMIT 50
        `;

        const result = await pool.query(query);
        return result.rows;
    } catch (error) {
        console.error('Error getting overdue objects:', error);
        throw error;
    }
}



// Отримання щомісячних даних про прострочені платежі (оновлений)
static async getOverdueByMonth() {
    try {
        // Отримуємо дані за останні 6 місяців
        const query = `
            WITH months AS (
                SELECT 
                    generate_series(
                        date_trunc('month', current_date) - interval '5 months',
                        date_trunc('month', current_date),
                        interval '1 month'
                    ) as month_start
            ),
            object_start_dates AS (
                -- Отримуємо для кожного об'єкта дату призначення клієнту або встановлення тарифу (що пізніше)
                SELECT 
                    o.id as object_id,
                    GREATEST(
                        COALESCE((SELECT MIN(start_date) FROM wialon.object_ownership_history WHERE object_id = o.id), '2000-01-01'::date),
                        COALESCE((SELECT MIN(effective_from) FROM billing.object_tariffs WHERE object_id = o.id), '2000-01-01'::date)
                    ) as start_date
                FROM wialon.objects o
                WHERE o.status = 'active'
            ),
            monthly_object_data AS (
                SELECT 
                    m.month_start,
                    EXTRACT(MONTH FROM m.month_start) as month,
                    EXTRACT(YEAR FROM m.month_start) as year,
                    -- Сума заборгованості за об'єкти з логікою більшості днів
                    (
                        WITH period_objects AS (
                            SELECT 
                                o.id as object_id
                            FROM wialon.objects o
                            JOIN object_start_dates osd ON o.id = osd.object_id
                            WHERE o.status = 'active'
                            AND m.month_start >= date_trunc('month', osd.start_date)
                        ),
                        object_period_tariffs AS (
                            SELECT 
                                po.object_id,
                                ot.tariff_id,
                                t.price,
                                EXTRACT(days FROM 
                                    LEAST(
                                        m.month_start + interval '1 month',
                                        COALESCE(ot.effective_to, '9999-12-31'::date)
                                    ) - GREATEST(
                                        m.month_start,
                                        ot.effective_from::date
                                    )
                                ) as days_count
                            FROM period_objects po
                            JOIN billing.object_tariffs ot ON po.object_id = ot.object_id
                            JOIN billing.tariffs t ON ot.tariff_id = t.id
                            WHERE 
                                ot.effective_from::date < m.month_start + interval '1 month'
                                AND COALESCE(ot.effective_to, '9999-12-31'::date) > m.month_start
                        ),
                        object_majority_tariffs AS (
                            SELECT 
                                object_id,
                                price,
                                ROW_NUMBER() OVER (
                                    PARTITION BY object_id 
                                    ORDER BY days_count DESC, tariff_id DESC
                                ) as rn
                            FROM object_period_tariffs
                            WHERE days_count > 0
                        )
                        SELECT COALESCE(SUM(omt.price), 0)
                        FROM object_majority_tariffs omt
                        WHERE omt.rn = 1
                        AND NOT EXISTS (
                            SELECT 1 FROM billing.object_payment_records opr
                            WHERE opr.object_id = omt.object_id
                            AND opr.billing_year = EXTRACT(YEAR FROM m.month_start)
                            AND opr.billing_month = EXTRACT(MONTH FROM m.month_start)
                            AND opr.status IN ('paid', 'partial')
                        )
                    ) as object_amount,
                    -- Сума оплачених рахунків для об'єктів
                    (
                        SELECT COALESCE(SUM(opr.amount), 0)
                        FROM billing.object_payment_records opr
                        JOIN wialon.objects o ON opr.object_id = o.id
                        WHERE opr.billing_year = EXTRACT(YEAR FROM m.month_start)
                        AND opr.billing_month = EXTRACT(MONTH FROM m.month_start)
                        AND opr.status IN ('paid', 'partial')
                        AND o.status = 'active'
                    ) as object_paid_amount
                FROM months m
            ),
            monthly_fixed_data AS (
                SELECT 
                    m.month_start,
                    EXTRACT(MONTH FROM m.month_start) as month,
                    EXTRACT(YEAR FROM m.month_start) as year,
                    -- Сума заборгованості за фіксовані послуги
                    (
                        SELECT COALESCE(SUM(i.total_amount), 0)
                        FROM services.invoices i
                        JOIN services.invoice_items ii ON i.id = ii.invoice_id
                        JOIN services.services s ON ii.service_id = s.id
                        WHERE i.status = 'issued'
                        AND s.service_type = 'fixed'
                        AND i.billing_year = EXTRACT(YEAR FROM m.month_start)
                        AND i.billing_month = EXTRACT(MONTH FROM m.month_start)
                    ) as fixed_amount,
                    -- Сума оплачених рахунків для фіксованих послуг
                    (
                        SELECT COALESCE(SUM(i.total_amount), 0)
                        FROM services.invoices i
                        JOIN services.invoice_items ii ON i.id = ii.invoice_id
                        JOIN services.services s ON ii.service_id = s.id
                        WHERE i.status = 'paid'
                        AND s.service_type = 'fixed'
                        AND i.billing_year = EXTRACT(YEAR FROM m.month_start)
                        AND i.billing_month = EXTRACT(MONTH FROM m.month_start)
                    ) as fixed_paid_amount
                FROM months m
            ),
            combined_data AS (
                SELECT 
                    obj.month,
                    obj.year,
                    obj.object_amount + fix.fixed_amount as amount,
                    obj.object_paid_amount + fix.fixed_paid_amount as paidAmount,
                    obj.object_amount as objectAmount,
                    fix.fixed_amount as fixedAmount,
                    obj.object_paid_amount as objectPaidAmount,
                    fix.fixed_paid_amount as fixedPaidAmount
                FROM monthly_object_data obj
                JOIN monthly_fixed_data fix ON obj.month_start = fix.month_start
            )
            SELECT * FROM combined_data
            ORDER BY year, month
        `;

        const result = await pool.query(query);
        return result.rows;
    } catch (error) {
        console.error('Error getting monthly overdue data:', error);
        throw error;
    }
}
}
//test
module.exports = PaymentService;