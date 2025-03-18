const { pool } = require('../database');
const AuditService = require('./auditService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

class ServiceService {
    // Отримання списку послуг з фільтрацією та пагінацією
    static async getServices(filters) {
        const {
            page = 1,
            perPage = 10,
            sortBy = 'name',
            descending = false,
            search = '',
            service_type = null,
            is_active = null
        } = filters;

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                s.name ILIKE $${paramIndex} OR
                s.description ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (service_type) {
            conditions.push(`s.service_type = $${paramIndex}`);
            params.push(service_type);
            paramIndex++;
        }

        if (is_active !== null) {
            conditions.push(`s.is_active = $${paramIndex}`);
            params.push(is_active === 'true' || is_active === true);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
        
        // Визначення поля для сортування
        let orderByField;
        switch(sortBy) {
            case 'name':
                orderByField = 's.name';
                break;
            case 'service_type':
                orderByField = 's.service_type';
                break;
            case 'fixed_price':
                orderByField = 's.fixed_price';
                break;
            case 'is_active':
                orderByField = 's.is_active';
                break;
            case 'clients_count':
                orderByField = 'clients_count';
                break;
            case 'created_at':
                orderByField = 's.created_at';
                break;
            default:
                orderByField = 's.name';
        }

        // Обробка опції "всі записи" для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        let query = `
            SELECT 
                s.*,
                COUNT(DISTINCT cs.client_id) as clients_count
            FROM services.services s
            LEFT JOIN services.client_services cs ON s.id = cs.service_id AND cs.end_date IS NULL
            ${whereClause}
            GROUP BY s.id
            ORDER BY ${orderByField} ${orderDirection}
        `;

        if (limit !== null) {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
        }

        const countQuery = `
            SELECT COUNT(*) FROM services.services s
            ${whereClause}
        `;

        const [servicesResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
        ]);

        return {
            services: servicesResult.rows,
            total: parseInt(countResult.rows[0].count)
        };
    }

    // Отримання послуги за ID з детальною інформацією
    static async getServiceById(id) {
        const serviceQuery = `
            SELECT 
                s.*,
                COUNT(DISTINCT cs.client_id) as clients_count
            FROM services.services s
            LEFT JOIN services.client_services cs ON s.id = cs.service_id AND cs.end_date IS NULL
            WHERE s.id = $1
            GROUP BY s.id
        `;

        const result = await pool.query(serviceQuery, [id]);
        
        if (result.rows.length === 0) {
            return null;
        }

        // Отримуємо клієнтів, які використовують цю послугу
        const clientsQuery = `
            SELECT 
                cs.id,
                c.id as client_id,
                c.name as client_name,
                cs.start_date,
                cs.end_date,
                cs.status,
                COUNT(o.id) as objects_count,
                CASE 
                    WHEN s.service_type = 'fixed' THEN s.fixed_price
                    WHEN s.service_type = 'object_based' THEN (
                        SELECT COALESCE(SUM(t.price), 0)
                        FROM wialon.objects o
                        JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
                        JOIN billing.tariffs t ON ot.tariff_id = t.id
                        WHERE o.client_id = c.id AND o.status = 'active'
                    )
                    ELSE 0
                END as calculated_price
            FROM services.client_services cs
            JOIN services.services s ON cs.service_id = s.id
            JOIN clients.clients c ON cs.client_id = c.id
            LEFT JOIN wialon.objects o ON o.client_id = c.id AND o.status = 'active'
            WHERE cs.service_id = $1 AND (cs.end_date IS NULL OR cs.end_date > CURRENT_DATE)
            GROUP BY cs.id, c.id, c.name, cs.start_date, cs.end_date, cs.status, s.service_type, s.fixed_price
            ORDER BY c.name
        `;

        const clientsResult = await pool.query(clientsQuery, [id]);
        
        const service = result.rows[0];
        service.clients = clientsResult.rows;
        
        return service;
    }

    // Створення нової послуги
    static async createService(client, data, userId, req) {
        try {
            const { 
                name, description, service_type, fixed_price, is_active 
            } = data;

            // Валідація типу послуги
            if (!service_type || !['fixed', 'object_based'].includes(service_type)) {
                throw new Error('Невірний тип послуги. Допустимі значення: fixed, object_based');
            }

            // Для фіксованої послуги потрібна ціна
            if (service_type === 'fixed' && (fixed_price === undefined || fixed_price === null)) {
                throw new Error('Для послуги з фіксованою ціною необхідно вказати ціну');
            }

            // Перевірка наявності послуги з такою назвою
            const existingService = await client.query(
                'SELECT id FROM services.services WHERE name = $1',
                [name]
            );

            if (existingService.rows.length > 0) {
                throw new Error('Послуга з такою назвою вже існує');
            }

            // Створення послуги
            const result = await client.query(
                `INSERT INTO services.services (
                    name, description, service_type, fixed_price, is_active
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [
                    name, 
                    description, 
                    service_type, 
                    service_type === 'fixed' ? fixed_price : null, 
                    is_active !== undefined ? is_active : true
                ]
            );

            const newService = result.rows[0];

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'SERVICE_CREATE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'SERVICE',  // Це потрібно додати в ENTITY_TYPES
                entityId: newService.id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'services',
                tableName: 'services',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return newService;
        } catch (error) {
            throw error;
        }
    }

    // Оновлення існуючої послуги
    static async updateService(client, id, data, userId, req) {
        try {
            // Отримання поточних даних послуги для аудиту
            const currentService = await client.query(
                'SELECT * FROM services.services WHERE id = $1',
                [id]
            );

            if (currentService.rows.length === 0) {
                throw new Error('Послуга не знайдена');
            }

            const oldData = currentService.rows[0];

            // Валідація типу послуги
            if (data.service_type && !['fixed', 'object_based'].includes(data.service_type)) {
                throw new Error('Невірний тип послуги. Допустимі значення: fixed, object_based');
            }

            // Для фіксованої послуги потрібна ціна
            if ((data.service_type === 'fixed' || (oldData.service_type === 'fixed' && data.service_type === undefined)) && 
                (data.fixed_price === undefined && oldData.fixed_price === null)) {
                throw new Error('Для послуги з фіксованою ціною необхідно вказати ціну');
            }

            // Перевірка унікальності назви
            if (data.name && data.name !== oldData.name) {
                const existingService = await client.query(
                    'SELECT id FROM services.services WHERE name = $1 AND id != $2',
                    [data.name, id]
                );

                if (existingService.rows.length > 0) {
                    throw new Error('Послуга з такою назвою вже існує');
                }
            }

            // Підготовка оновлених даних
            const updateFields = [];
            const updateValues = [];
            let paramIndex = 1;

            const fieldsToUpdate = [
                'name', 'description', 'service_type', 'fixed_price', 'is_active'
            ];

            for (const field of fieldsToUpdate) {
                if (data[field] !== undefined) {
                    // Особлива логіка для fixed_price
                    if (field === 'fixed_price') {
                        const serviceType = data.service_type || oldData.service_type;
                        updateFields.push(`${field} = $${paramIndex++}`);
                        updateValues.push(serviceType === 'fixed' ? data[field] : null);
                    } else {
                        updateFields.push(`${field} = $${paramIndex++}`);
                        updateValues.push(data[field]);
                    }
                }
            }

            updateFields.push(`updated_at = $${paramIndex++}`);
            updateValues.push(new Date());
            updateValues.push(id);

            // Оновлення послуги
            const result = await client.query(
                `UPDATE services.services 
                 SET ${updateFields.join(', ')}
                 WHERE id = $${paramIndex}
                 RETURNING *`,
                updateValues
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'SERVICE_UPDATE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'SERVICE',  // Це потрібно додати в ENTITY_TYPES
                entityId: id,
                oldValues: oldData,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'services',
                tableName: 'services',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Видалення послуги
    static async deleteService(client, id, userId, req) {
        try {
            // Перевірка чи є клієнти, які використовують цю послугу
            const clientsCheck = await client.query(
                'SELECT id FROM services.client_services WHERE service_id = $1 AND (end_date IS NULL OR end_date > CURRENT_DATE) LIMIT 1',
                [id]
            );

            if (clientsCheck.rows.length > 0) {
                throw new Error('Неможливо видалити послугу, яку використовують клієнти');
            }

            // Перевірка чи є рахунки, пов'язані з цією послугою
            const invoicesCheck = await client.query(
                'SELECT id FROM services.invoice_items WHERE service_id = $1 LIMIT 1',
                [id]
            );

            if (invoicesCheck.rows.length > 0) {
                throw new Error('Неможливо видалити послугу, яка використовується в рахунках');
            }

            // Отримання даних послуги для аудиту
            const serviceData = await client.query(
                'SELECT * FROM services.services WHERE id = $1',
                [id]
            );

            if (serviceData.rows.length === 0) {
                throw new Error('Послуга не знайдена');
            }

            // Видалення історичних записів про використання послуги
            await client.query(
                'DELETE FROM services.client_services WHERE service_id = $1 AND end_date IS NOT NULL AND end_date <= CURRENT_DATE',
                [id]
            );

            // Видалення послуги
            await client.query(
                'DELETE FROM services.services WHERE id = $1',
                [id]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'SERVICE_DELETE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'SERVICE',  // Це потрібно додати в ENTITY_TYPES
                entityId: id,
                oldValues: serviceData.rows[0],
                ipAddress: req.ip,
                tableSchema: 'services',
                tableName: 'services',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    // Призначення послуги клієнту
    static async assignServiceToClient(client, data, userId, req) {
        try {
            const { client_id, service_id, start_date, notes } = data;

            if (!client_id || !service_id) {
                throw new Error('ID клієнта та послуги обов\'язкові');
            }

            // Перевірка наявності клієнта
            const clientExists = await client.query(
                'SELECT id FROM clients.clients WHERE id = $1',
                [client_id]
            );

            if (clientExists.rows.length === 0) {
                throw new Error('Вказаний клієнт не існує');
            }

            // Перевірка наявності послуги
            const serviceExists = await client.query(
                'SELECT id, service_type FROM services.services WHERE id = $1',
                [service_id]
            );

            if (serviceExists.rows.length === 0) {
                throw new Error('Вказана послуга не існує');
            }

            // Перевірка чи вже призначена ця послуга клієнту
            const existingAssignment = await client.query(
                `SELECT id FROM services.client_services 
                 WHERE client_id = $1 AND service_id = $2 AND (end_date IS NULL OR end_date > CURRENT_DATE)`,
                [client_id, service_id]
            );

            if (existingAssignment.rows.length > 0) {
                throw new Error('Ця послуга вже призначена клієнту');
            }

            const effectiveDate = start_date ? new Date(start_date) : new Date();

            // Додаємо новий запис про призначення послуги
            const result = await client.query(
                `INSERT INTO services.client_services (
                    client_id, service_id, start_date, status, notes
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [
                    client_id, 
                    service_id, 
                    effectiveDate, 
                    'active', 
                    notes
                ]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'SERVICE_ASSIGN',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'CLIENT_SERVICE',  // Це потрібно додати в ENTITY_TYPES
                entityId: result.rows[0].id,
                newValues: data,
                ipAddress: req.ip,
                tableSchema: 'services',
                tableName: 'client_services',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Припинення надання послуги клієнту
    static async terminateClientService(client, id, data, userId, req) {
        try {
            const { end_date, notes } = data;

            // Перевірка наявності призначення послуги
            const assignmentExists = await client.query(
                'SELECT * FROM services.client_services WHERE id = $1',
                [id]
            );

            if (assignmentExists.rows.length === 0) {
                throw new Error('Призначення послуги не знайдено');
            }

            const oldData = assignmentExists.rows[0];

            // Якщо послуга вже припинена
            if (oldData.end_date !== null && oldData.end_date <= new Date()) {
                throw new Error('Надання послуги вже припинено');
            }

            const terminationDate = end_date ? new Date(end_date) : new Date();

            // Оновлюємо запис про призначення послуги
            const result = await client.query(
                `UPDATE services.client_services 
                 SET end_date = $1, status = $2, notes = $3, updated_at = $4
                 WHERE id = $5
                 RETURNING *`,
                [
                    terminationDate, 
                    'terminated', 
                    notes || oldData.notes, 
                    new Date(), 
                    id
                ]
            );

            // Аудит
            await AuditService.log({
                userId,
                actionType: 'SERVICE_TERMINATE',  // Це потрібно додати в AUDIT_LOG_TYPES
                entityType: 'CLIENT_SERVICE',  // Це потрібно додати в ENTITY_TYPES
                entityId: id,
                oldValues: oldData,
                newValues: { end_date: terminationDate, status: 'terminated', notes },
                ipAddress: req.ip,
                tableSchema: 'services',
                tableName: 'client_services',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });

            return result.rows[0];
        } catch (error) {
            throw error;
        }
    }

    // Отримання послуг клієнта
    static async getClientServices(clientId) {
        const query = `
            SELECT 
                cs.*,
                s.name as service_name,
                s.description as service_description,
                s.service_type,
                s.fixed_price,
                CASE 
                    WHEN s.service_type = 'fixed' THEN s.fixed_price
                    WHEN s.service_type = 'object_based' THEN (
                        SELECT COALESCE(SUM(t.price), 0)
                        FROM wialon.objects o
                        JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
                        JOIN billing.tariffs t ON ot.tariff_id = t.id
                        WHERE o.client_id = cs.client_id AND o.status = 'active'
                    )
                    ELSE 0
                END as calculated_price,
                COUNT(o.id) as objects_count
            FROM services.client_services cs
            JOIN services.services s ON cs.service_id = s.id
            LEFT JOIN wialon.objects o ON o.client_id = cs.client_id AND o.status = 'active'
            WHERE cs.client_id = $1
            GROUP BY cs.id, s.name, s.description, s.service_type, s.fixed_price
            ORDER BY cs.start_date DESC
        `;

        const result = await pool.query(query, [clientId]);
        return result.rows;
    }

    // Створення рахунку
// Створення рахунку
static async createInvoice(client, data, userId, req) {
    try {
        const { 
            client_id, invoice_date, billing_month, billing_year, 
            items, notes 
        } = data;

        if (!client_id || !items || !Array.isArray(items) || items.length === 0) {
            throw new Error('ID клієнта та перелік послуг обов\'язкові');
        }

        // Перевірка наявності клієнта
        const clientExists = await client.query(
            'SELECT id FROM clients.clients WHERE id = $1',
            [client_id]
        );

        if (clientExists.rows.length === 0) {
            throw new Error('Вказаний клієнт не існує');
        }

        // Генерація номера рахунку
        const invoiceDate = invoice_date ? new Date(invoice_date) : new Date();
        const month = billing_month || (invoiceDate.getMonth() + 1);
        const year = billing_year || invoiceDate.getFullYear();
        
        // Отримуємо останній номер рахунку
        const lastInvoiceNumber = await client.query(
            `SELECT invoice_number FROM services.invoices
             WHERE client_id = $1 AND billing_year = $2
             ORDER BY invoice_number DESC
             LIMIT 1`,
            [client_id, year]
        );
        
        let invoiceNumber;
        if (lastInvoiceNumber.rows.length > 0) {
            const lastNumber = parseInt(lastInvoiceNumber.rows[0].invoice_number.split('-')[1], 10);
            invoiceNumber = `${year}-${(lastNumber + 1).toString().padStart(4, '0')}`;
        } else {
            invoiceNumber = `${year}-0001`;
        }

        // Розрахунок загальної суми
        let totalAmount = 0;
        for (const item of items) {
            totalAmount += (item.quantity || 1) * item.unit_price;
        }

        // Створення рахунку
        const invoiceResult = await client.query(
            `INSERT INTO services.invoices (
                client_id, invoice_number, invoice_date, billing_month, 
                billing_year, total_amount, status, notes, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [
                client_id, 
                invoiceNumber, 
                invoiceDate, 
                month, 
                year, 
                totalAmount, 
                'issued', 
                notes, 
                userId
            ]
        );

        const invoiceId = invoiceResult.rows[0].id;

        // Додавання позицій рахунку з перевіркою типу послуги
        for (const item of items) {
            if (!item.service_id) {
                throw new Error('ID послуги обов\'язковий для кожної позиції рахунку');
            }
            
            // Отримуємо інформацію про послугу
            const serviceInfo = await client.query(
                `SELECT id, name, service_type, fixed_price FROM services.services WHERE id = $1`,
                [item.service_id]
            );
            
            if (serviceInfo.rows.length === 0) {
                throw new Error(`Послуга з ID ${item.service_id} не знайдена`);
            }
            
            const service = serviceInfo.rows[0];
            
            // Якщо послуга типу object_based, перевіряємо чи вона призначена клієнту
            if (service.service_type === 'object_based') {
                // Перевіряємо чи призначена послуга клієнту
                const assignedService = await client.query(
                    `SELECT id FROM services.client_services 
                    WHERE client_id = $1 AND service_id = $2 
                    AND status = 'active' AND (end_date IS NULL OR end_date > CURRENT_DATE)`,
                    [client_id, item.service_id]
                );
                
                if (assignedService.rows.length === 0) {
                    throw new Error(`Послуга типу object_based (${service.name}) повинна бути призначена клієнту перед використанням у рахунку`);
                }
                
                // Для object_based послуг може бути окрема логіка розрахунку
                // Отримуємо всі об'єкти клієнта
                const objectsResult = await client.query(
                    `SELECT o.id, o.name, t.price 
                    FROM wialon.objects o
                    JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
                    JOIN billing.tariffs t ON ot.tariff_id = t.id
                    WHERE o.client_id = $1 AND o.status = 'active'`,
                    [client_id]
                );
                
                // Розраховуємо загальну вартість для всіх об'єктів з урахуванням дати призначення
                let totalObjectsPrice = 0;
                let includedObjectsCount = 0;
                
                for (const obj of objectsResult.rows) {
                    // Перевіряємо, чи потрібно нараховувати оплату за цей об'єкт за поточний місяць
                    const shouldChargeResult = await client.query(
                        `SELECT billing.should_charge_for_month($1, $2, $3, $4) as should_charge`,
                        [obj.id, client_id, year, month]
                    );
                    
                    if (shouldChargeResult.rows[0].should_charge) {
                        totalObjectsPrice += obj.price;
                        includedObjectsCount++;
                    }
                }
                
                // Якщо є об'єкти для нарахування, додаємо позицію рахунку
                if (includedObjectsCount > 0) {
                    // Опис з переліком об'єктів
                    const description = item.description || 
                        `${service.name} (${includedObjectsCount} об'єктів)`;
                    
                    await client.query(
                        `INSERT INTO services.invoice_items (
                            invoice_id, service_id, description, quantity, 
                            unit_price, total_price
                        )
                        VALUES ($1, $2, $3, $4, $5, $6)`,
                        [
                            invoiceId, 
                            item.service_id, 
                            description, 
                            1, 
                            totalObjectsPrice, 
                            totalObjectsPrice
                        ]
                    );
                }
            } else {
                // Для fixed послуг не перевіряємо призначення клієнту
                await client.query(
                    `INSERT INTO services.invoice_items (
                        invoice_id, service_id, description, quantity, 
                        unit_price, total_price
                    )
                    VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        invoiceId, 
                        item.service_id, 
                        item.description || service.name, 
                        item.quantity || 1, 
                        service.service_type === 'fixed' ? service.fixed_price : item.unit_price, 
                        (item.quantity || 1) * (service.service_type === 'fixed' ? service.fixed_price : item.unit_price)
                    ]
                );
            }
        }

        // Аудит
        await AuditService.log({
            userId,
            actionType: 'INVOICE_CREATE',  // Це потрібно додати в AUDIT_LOG_TYPES
            entityType: 'INVOICE',  // Це потрібно додати в ENTITY_TYPES
            entityId: invoiceId,
            newValues: { 
                client_id, invoice_number: invoiceNumber, invoice_date: invoiceDate, 
                billing_month: month, billing_year: year, total_amount: totalAmount,
                items, notes
            },
            ipAddress: req.ip,
            tableSchema: 'services',
            tableName: 'invoices',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        // Повертаємо створений рахунок з позиціями
        const result = await client.query(
            `SELECT 
                i.*,
                c.name as client_name,
                json_agg(
                    jsonb_build_object(
                        'id', ii.id,
                        'service_id', ii.service_id,
                        'service_name', s.name,
                        'description', ii.description,
                        'quantity', ii.quantity,
                        'unit_price', ii.unit_price,
                        'total_price', ii.total_price
                    )
                ) as items
            FROM services.invoices i
            JOIN clients.clients c ON i.client_id = c.id
            LEFT JOIN services.invoice_items ii ON i.id = ii.invoice_id
            LEFT JOIN services.services s ON ii.service_id = s.id
            WHERE i.id = $1
            GROUP BY i.id, c.name`,
            [invoiceId]
        );

        return result.rows[0];
    } catch (error) {
        throw error;
    }
}
// Метод для створення платежу
static async createPayment(client, data, userId, req) {
    try {
        const { 
            client_id, amount, payment_date, payment_type = 'regular', 
            invoice_id, notes 
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
                paymentDate,
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

static async getAllInvoices(filters) {
    const {
        page = 1,
        perPage = 10,
        sortBy = 'invoice_date',
        descending = true,
        search = '',
        status = null,
        year = null,
        month = null
    } = filters;

    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (search) {
        conditions.push(`(
            i.invoice_number ILIKE $${paramIndex} OR
            c.name ILIKE $${paramIndex}
        )`);
        params.push(`%${search}%`);
        paramIndex++;
    }

    if (status) {
        conditions.push(`i.status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
    }

    if (year) {
        conditions.push(`i.billing_year = $${paramIndex}`);
        params.push(parseInt(year));
        paramIndex++;
    }

    if (month) {
        conditions.push(`i.billing_month = $${paramIndex}`);
        params.push(parseInt(month));
        paramIndex++;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const orderDirection = descending ? 'DESC' : 'ASC';
    
    // Визначення поля для сортування
    let orderByField;
    switch(sortBy) {
        case 'invoice_date':
            orderByField = 'i.invoice_date';
            break;
        case 'invoice_number':
            orderByField = 'i.invoice_number';
            break;
        case 'client_name':
            orderByField = 'c.name';
            break;
        case 'status':
            orderByField = 'i.status';
            break;
        case 'total_amount':
            orderByField = 'i.total_amount';
            break;
        case 'billing_period':
            orderByField = 'i.billing_year, i.billing_month';
            break;
        default:
            orderByField = 'i.invoice_date';
    }

    // Обробка опції "всі записи" для експорту
    const limit = perPage === 'All' ? null : parseInt(perPage);
    const offset = limit ? (parseInt(page) - 1) * limit : 0;
    
    let query = `
        SELECT 
            i.*,
            c.name as client_name,
            COUNT(ii.id) as items_count,
            p.payment_date
        FROM services.invoices i
        JOIN clients.clients c ON i.client_id = c.id
        LEFT JOIN services.invoice_items ii ON i.id = ii.invoice_id
        LEFT JOIN billing.payments p ON i.payment_id = p.id
        ${whereClause}
        GROUP BY i.id, c.name, c.id, p.payment_date
        ORDER BY ${orderByField} ${orderDirection}
    `;

    if (limit !== null) {
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
    }

    const countQuery = `
        SELECT COUNT(DISTINCT i.id) FROM services.invoices i
        JOIN clients.clients c ON i.client_id = c.id
        ${whereClause}
    `;

    const [invoicesResult, countResult] = await Promise.all([
        pool.query(query, params),
        pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
    ]);

    return {
        invoices: invoicesResult.rows,
        total: parseInt(countResult.rows[0].count)
    };
}

    // Отримання рахунків клієнта
    static async getClientInvoices(clientId, filters = {}) {
        const { 
            page = 1, 
            perPage = 10, 
            sortBy = 'invoice_date', 
            descending = true,
            status = null,
            year = null,
            month = null
        } = filters;

        let conditions = [`i.client_id = $1`];
        let params = [clientId];
        let paramIndex = 2;

        if (status) {
            conditions.push(`i.status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        if (year) {
            conditions.push(`i.billing_year = $${paramIndex}`);
            params.push(parseInt(year));
            paramIndex++;
        }

        if (month) {
            conditions.push(`i.billing_month = $${paramIndex}`);
            params.push(parseInt(month));
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const orderDirection = descending === 'true' || descending === true ? 'DESC' : 'ASC';
        
        // Визначення поля для сортування
        let orderByField;
        switch(sortBy) {
            case 'invoice_date':
                orderByField = 'i.invoice_date';
                break;
            case 'invoice_number':
                orderByField = 'i.invoice_number';
                break;
            case 'status':
                orderByField = 'i.status';
                break;
            case 'total_amount':
                orderByField = 'i.total_amount';
                break;
            case 'billing_period':
                orderByField = 'i.billing_year, i.billing_month';
                break;
            default:
                orderByField = 'i.invoice_date';
        }

        // Обробка опції "всі записи" для експорту
        const limit = perPage === 'All' ? null : parseInt(perPage);
        const offset = limit ? (parseInt(page) - 1) * limit : 0;
        
        let query = `
            SELECT 
                i.*,
                COUNT(ii.id) as items_count,
                p.id as payment_id,
                p.payment_date
            FROM services.invoices i
            LEFT JOIN services.invoice_items ii ON i.id = ii.invoice_id
            LEFT JOIN billing.payments p ON i.payment_id = p.id
            ${whereClause}
            GROUP BY i.id, p.id, p.payment_date
            ORDER BY ${orderByField} ${orderDirection}
        `;

        if (limit !== null) {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
        }

        const countQuery = `
            SELECT COUNT(DISTINCT i.id) FROM services.invoices i
            ${whereClause}
        `;

        const [invoicesResult, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, conditions.length ? params.slice(0, paramIndex - 1) : [])
        ]);

        return {
            invoices: invoicesResult.rows,
            total: parseInt(countResult.rows[0].count)
        };
    }

    // Отримання деталей рахунку
// Отримання деталей рахунку
static async getInvoiceDetails(id) {
    const query = `
        SELECT 
            i.*,
            c.name as client_name,
            c.address as client_address,
            p.id as payment_id,
            p.payment_date,
            json_agg(
                jsonb_build_object(
                    'id', ii.id,
                    'service_id', ii.service_id,
                    'service_name', s.name,
                    'description', ii.description,
                    'quantity', ii.quantity,
                    'unit_price', ii.unit_price,
                    'total_price', ii.total_price
                )
            ) as items,
            json_agg(
                jsonb_build_object(
                    'id', id.id,
                    'document_name', id.document_name,
                    'document_type', id.document_type,
                    'file_path', id.file_path,
                    'created_at', id.created_at
                )
            ) FILTER (WHERE id.id IS NOT NULL) as documents
        FROM services.invoices i
        JOIN clients.clients c ON i.client_id = c.id
        LEFT JOIN services.invoice_items ii ON i.id = ii.invoice_id
        LEFT JOIN services.services s ON ii.service_id = s.id
        LEFT JOIN services.invoice_documents id ON i.id = id.invoice_id
        LEFT JOIN billing.payments p ON i.payment_id = p.id
        WHERE i.id = $1
        GROUP BY i.id, c.name, c.address, p.id, p.payment_date
    `;

    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
        return null;
    }
    
    return result.rows[0];
}

// Зміна статусу рахунку
static async updateInvoiceStatus(client, id, data, userId, req) {
    try {
        const { status, payment_date, amount, payment_type, notes } = data;

        if (!status || !['issued', 'paid', 'cancelled'].includes(status)) {
            throw new Error('Невірний статус рахунку. Допустимі значення: issued, paid, cancelled');
        }

        // Перевірка наявності рахунку
        const invoiceExists = await client.query(
            'SELECT * FROM services.invoices WHERE id = $1',
            [id]
        );

        if (invoiceExists.rows.length === 0) {
            throw new Error('Рахунок не знайдено');
        }

        const oldData = invoiceExists.rows[0];
        
        let paymentId = null;

        // Якщо статус змінюється на "оплачено", створюємо платіж
        if (status === 'paid') {
            if (!payment_date) {
                throw new Error('Для статусу "оплачено" необхідно вказати дату оплати');
            }

            // Створення платежу
            const paymentResult = await client.query(
                `INSERT INTO billing.payments (
                    client_id, amount, payment_date, payment_month, 
                    payment_year, payment_type, notes, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *`,
                [
                    oldData.client_id,
                    amount || oldData.total_amount,
                    payment_date,
                    new Date(payment_date).getMonth() + 1,
                    new Date(payment_date).getFullYear(),
                    payment_type || 'regular',
                    notes || null,
                    userId
                ]
            );

            paymentId = paymentResult.rows[0].id;
            
            // Отримуємо всі позиції рахунку з метаданими про об'єкти
            const invoiceItemsResult = await client.query(
                `SELECT ii.*, s.service_type 
                FROM services.invoice_items ii
                JOIN services.services s ON ii.service_id = s.id
                WHERE ii.invoice_id = $1`,
                [id]
            );
            
            // Створюємо записи про оплату для кожного об'єкта
            for (const item of invoiceItemsResult.rows) {
                // Перевіряємо наявність метаданих
                if (!item.metadata) continue;
                
                // Якщо це послуга на основі об'єктів і є дані про об'єкти
                if (item.service_type === 'object_based' && item.metadata.objects && Array.isArray(item.metadata.objects)) {
                    // Для кожного об'єкта створюємо запис в таблиці object_payment_records
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
                                oldData.billing_month,
                                oldData.billing_year,
                                'paid'
                            ]
                        );
                    }
                }
                // Якщо це запис про заборгованість
                else if (item.metadata.is_debt && item.metadata.unpaid_invoices && Array.isArray(item.metadata.unpaid_invoices)) {
                    // Для кожного неоплаченого рахунку отримуємо інформацію про об'єкти
                    for (const unpaidInvoice of item.metadata.unpaid_invoices) {
                        // Отримуємо позиції неоплаченого рахунку
                        const unpaidItemsResult = await client.query(
                            `SELECT ii.*, s.service_type 
                            FROM services.invoice_items ii
                            JOIN services.services s ON ii.service_id = s.id
                            WHERE ii.invoice_id = $1 AND s.service_type = 'object_based'`,
                            [unpaidInvoice.id]
                        );
                        
                        // Для кожної позиції з об'єктами
                        for (const unpaidItem of unpaidItemsResult.rows) {
                            if (unpaidItem.metadata && unpaidItem.metadata.objects) {
                                // Для кожного об'єкта створюємо запис у object_payment_records
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
                        
                        // Змінюємо статус неоплаченого рахунку на "paid"
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

        // Оновлюємо статус рахунку
        const result = await client.query(
            `UPDATE services.invoices 
             SET status = $1, payment_id = $2, notes = $3, updated_at = $4
             WHERE id = $5
             RETURNING *`,
            [
                status, 
                status === 'paid' ? paymentId : null, 
                notes || oldData.notes, 
                new Date(), 
                id
            ]
        );

        // Аудит
        await AuditService.log({
            userId,
            actionType: 'INVOICE_STATUS_CHANGE',
            entityType: 'INVOICE',
            entityId: id,
            oldValues: oldData,
            newValues: { status, payment_id: paymentId, notes },
            ipAddress: req.ip,
            tableSchema: 'services',
            tableName: 'invoices',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });

        return result.rows[0];
    } catch (error) {
        throw error;
    }
}


// Метод для генерації щомісячних рахунків для клієнтів з послугами типу "object_based"
static async generateMonthlyInvoices(client, billingMonth, billingYear, userId, req) {
    try {
        // Отримуємо всіх клієнтів з активними послугами типу "object_based"
        const clientsWithServicesQuery = `
            SELECT DISTINCT c.id, c.name
            FROM clients.clients c
            JOIN services.client_services cs ON c.id = cs.client_id
            JOIN services.services s ON cs.service_id = s.id
            WHERE s.service_type = 'object_based'
            AND cs.status = 'active'
            AND (cs.end_date IS NULL OR cs.end_date >= $1)
            AND c.is_active = true
        `;
        const currentDate = new Date();
        const clientsResult = await client.query(clientsWithServicesQuery, [currentDate]);
        
        const createdInvoices = [];
        
        // Для кожного клієнта генеруємо рахунок
        for (const clientData of clientsResult.rows) {
            // Знаходимо всі активні послуги клієнта
            const servicesQuery = `
                SELECT s.id, s.name, s.service_type, s.fixed_price
                FROM services.client_services cs
                JOIN services.services s ON cs.service_id = s.id
                WHERE cs.client_id = $1
                AND cs.status = 'active'
                AND (cs.end_date IS NULL OR cs.end_date >= $2)
                AND s.is_active = true
            `;
            const servicesResult = await client.query(servicesQuery, [clientData.id, currentDate]);
            
            // Якщо немає активних послуг, пропускаємо
            if (servicesResult.rows.length === 0) {
                continue;
            }
            
            // Перевіряємо наявність заборгованості
            const unpaidInvoicesQuery = `
                SELECT i.id, i.billing_month, i.billing_year, i.total_amount, i.invoice_number
                FROM services.invoices i
                WHERE i.client_id = $1 
                AND i.status = 'issued'
                AND (i.billing_year < $2 OR (i.billing_year = $2 AND i.billing_month < $3))
                ORDER BY i.billing_year, i.billing_month
            `;
            
            const unpaidResult = await client.query(unpaidInvoicesQuery, [
                clientData.id, 
                billingYear, 
                billingMonth
            ]);
            
            // Формуємо інформацію про заборгованість
            let debtNotes = '';
            let debtTotal = 0;
            
            if (unpaidResult.rows.length > 0) {
                debtTotal = unpaidResult.rows.reduce((sum, row) => sum + parseFloat(row.total_amount), 0);
                
                debtNotes = `Заборгованість за попередні періоди: ${debtTotal.toFixed(2)} грн.\n`;
                debtNotes += unpaidResult.rows.map(row => 
                    `Рахунок №${row.invoice_number} (${row.billing_month}/${row.billing_year}): ${parseFloat(row.total_amount).toFixed(2)} грн.`
                ).join('\n');
            }
            
            // Перевіряємо, за які об'єкти клієнта вже виставлені рахунки за поточний період
            const existingInvoiceItemsQuery = `
                SELECT o.id as object_id
                FROM services.invoices i
                JOIN services.invoice_items ii ON i.id = ii.invoice_id
                JOIN services.services s ON ii.service_id = s.id
                CROSS JOIN jsonb_array_elements(ii.metadata->'objects') as obj
                JOIN wialon.objects o ON obj->>'id' = o.id::text
                WHERE i.client_id = $1
                AND i.billing_month = $2
                AND i.billing_year = $3
                AND s.service_type = 'object_based'
                AND i.status != 'cancelled'
            `;
            
            const existingItemsResult = await client.query(existingInvoiceItemsQuery, [
                clientData.id, 
                billingMonth,
                billingYear
            ]);
            
            // Створюємо множину об'єктів, за які вже виставлені рахунки
            const invoicedObjectsSet = new Set(
                existingItemsResult.rows.map(row => row.object_id)
            );
            
            // Створюємо позиції рахунку
            const invoiceItems = [];
            let totalAmount = 0;
            
            // Якщо є заборгованість, додаємо як окрему позицію
            if (debtTotal > 0) {
                invoiceItems.push({
                    service_id: servicesResult.rows[0].id, // Використовуємо першу активну послугу
                    description: `Заборгованість за попередні періоди`,
                    quantity: 1,
                    unit_price: debtTotal,
                    total_price: debtTotal,
                    metadata: {
                        is_debt: true,
                        unpaid_invoices: unpaidResult.rows.map(row => ({
                            id: row.id,
                            invoice_number: row.invoice_number,
                            billing_month: row.billing_month,
                            billing_year: row.billing_year,
                            amount: parseFloat(row.total_amount)
                        }))
                    }
                });
                
                totalAmount += debtTotal;
            }
            
            for (const service of servicesResult.rows) {
                if (service.service_type === 'fixed') {
                    // Для послуг з фіксованою ціною просто додаємо позицію
                    invoiceItems.push({
                        service_id: service.id,
                        description: service.name,
                        quantity: 1,
                        unit_price: service.fixed_price,
                        total_price: service.fixed_price,
                        metadata: {
                            service_type: 'fixed'
                        }
                    });
                    totalAmount += service.fixed_price;
                } else if (service.service_type === 'object_based') {
                    // Для послуг на основі об'єктів рахуємо за активними об'єктами клієнта
                    
                    // Отримуємо всі об'єкти клієнта з активними тарифами
                    const objectsQuery = `
                        SELECT o.id, o.name, t.id as tariff_id, t.name as tariff_name, t.price
                        FROM wialon.objects o
                        JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
                        JOIN billing.tariffs t ON ot.tariff_id = t.id
                        WHERE o.client_id = $1 AND o.status = 'active'
                    `;
                    const objectsResult = await client.query(objectsQuery, [clientData.id]);
                    
                    // Розраховуємо загальну вартість для всіх об'єктів з урахуванням дати призначення
                    let objectBasedTotal = 0;
                    const includedObjects = [];
                    const objectsMetadata = [];
                    
                    for (const obj of objectsResult.rows) {
                        // Пропускаємо об'єкти, за які вже виставлені рахунки
                        if (invoicedObjectsSet.has(obj.id)) {
                            continue;
                        }
                        
                        // Перевіряємо чи потрібно нараховувати оплату
                        const shouldChargeResult = await client.query(
                            `SELECT billing.should_charge_for_month($1, $2, $3, $4) as should_charge`,
                            [obj.id, clientData.id, billingYear, billingMonth]
                        );
                        
                        if (shouldChargeResult.rows[0].should_charge) {
                            objectBasedTotal += parseFloat(obj.price);
                            includedObjects.push(obj.name);
                            objectsMetadata.push({
                                id: obj.id,
                                name: obj.name,
                                tariff_id: obj.tariff_id,
                                tariff_name: obj.tariff_name,
                                price: parseFloat(obj.price)
                            });
                        }
                    }
                    
                    // Якщо є об'єкти для нарахування, додаємо позицію рахунку
                    if (objectBasedTotal > 0) {
                        const description = `${service.name}: ${includedObjects.join(', ')}`;
                        invoiceItems.push({
                            service_id: service.id,
                            description: description,
                            quantity: 1,
                            unit_price: objectBasedTotal,
                            total_price: objectBasedTotal,
                            metadata: {
                                service_type: 'object_based',
                                objects: objectsMetadata
                            }
                        });
                        totalAmount += objectBasedTotal;
                    }
                }
            }
            
            // Якщо немає позицій для рахунку, пропускаємо
            if (invoiceItems.length === 0 || totalAmount === 0) {
                continue;
            }
            
            // Генеруємо номер рахунку
            const lastInvoiceNumber = await client.query(
                `SELECT invoice_number FROM services.invoices
                 WHERE client_id = $1 AND billing_year = $2
                 ORDER BY invoice_number DESC
                 LIMIT 1`,
                [clientData.id, billingYear]
            );
            
            let invoiceNumber;
            if (lastInvoiceNumber.rows.length > 0) {
                const lastNumber = parseInt(lastInvoiceNumber.rows[0].invoice_number.split('-')[1], 10);
                invoiceNumber = `${billingYear}-${(lastNumber + 1).toString().padStart(4, '0')}`;
            } else {
                invoiceNumber = `${billingYear}-0001`;
            }
            
            // Створюємо рахунок з примітками про заборгованість
            const invoiceResult = await client.query(
                `INSERT INTO services.invoices (
                    client_id, invoice_number, invoice_date, billing_month, 
                    billing_year, total_amount, status, notes, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *`,
                [
                    clientData.id, 
                    invoiceNumber, 
                    currentDate, 
                    billingMonth, 
                    billingYear, 
                    totalAmount, 
                    'issued', 
                    debtNotes || null, 
                    userId
                ]
            );
            
            const invoiceId = invoiceResult.rows[0].id;
            
            // Додаємо позиції рахунку
            for (const item of invoiceItems) {
                await client.query(
                    `INSERT INTO services.invoice_items (
                        invoice_id, service_id, description, quantity, 
                        unit_price, total_price, metadata
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        invoiceId, 
                        item.service_id, 
                        item.description, 
                        item.quantity, 
                        item.unit_price, 
                        item.total_price,
                        item.metadata ? JSON.stringify(item.metadata) : null
                    ]
                );
            }
            
            // Очищаємо атрибути payment_required_month для об'єктів клієнта
            await client.query(
                `DELETE FROM wialon.object_attributes 
                 WHERE object_id IN (
                     SELECT id FROM wialon.objects WHERE client_id = $1
                 ) 
                 AND attribute_name = 'payment_required_month'
                 AND attribute_value = $2`,
                [clientData.id, `${billingMonth}-${billingYear}`]
            );
            
            // Додаємо створений рахунок до результату
            createdInvoices.push({
                id: invoiceId,
                invoice_number: invoiceNumber,
                client_id: clientData.id,
                client_name: clientData.name,
                total_amount: totalAmount,
                item_count: invoiceItems.length
            });
            
            // Аудит
            await AuditService.log({
                userId,
                actionType: 'INVOICE_CREATE',
                entityType: 'INVOICE',
                entityId: invoiceId,
                newValues: { 
                    client_id: clientData.id,
                    billing_month: billingMonth,
                    billing_year: billingYear,
                    total_amount: totalAmount,
                    items_count: invoiceItems.length,
                    has_debt: debtTotal > 0
                },
                ipAddress: req.ip,
                tableSchema: 'services',
                tableName: 'invoices',
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        }
        
        return createdInvoices;
    } catch (error) {
        throw error;
    }
}
}
// Допоміжна функція для перевірки, чи потрібно нараховувати оплату
async function shouldChargeForMonth(client, objectId, clientId, billingYear, billingMonth) {
    const result = await client.query(
        'SELECT billing.should_charge_for_month($1, $2, $3, $4) as should_charge',
        [objectId, clientId, billingYear, billingMonth]
    );
    return result.rows[0].should_charge;
}

// Допоміжна функція для генерації номера рахунку
async function generateInvoiceNumber(client, clientId, year) {
    // Отримуємо останній номер рахунку
    const lastInvoiceNumber = await client.query(
        `SELECT invoice_number FROM services.invoices
         WHERE client_id = $1 AND billing_year = $2
         ORDER BY invoice_number DESC
         LIMIT 1`,
        [clientId, year]
    );
    
    let invoiceNumber;
    if (lastInvoiceNumber.rows.length > 0) {
        const lastNumber = parseInt(lastInvoiceNumber.rows[0].invoice_number.split('-')[1], 10);
        invoiceNumber = `${year}-${(lastNumber + 1).toString().padStart(4, '0')}`;
    } else {
        invoiceNumber = `${year}-0001`;
    }
    
    return invoiceNumber;
}




module.exports = ServiceService;