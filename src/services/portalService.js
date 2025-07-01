const { pool } = require('../database');

class PortalService {
    // Отримання профілю клієнта
    static async getClientProfile(clientId) {
        const result = await pool.query(
            `SELECT 
                c.id, c.name, c.full_name, c.email, c.phone, c.address,
                c.contact_person, c.wialon_username, c.created_at,
                COUNT(DISTINCT o.id) as objects_count,
                COUNT(DISTINCT cd.id) as documents_count
             FROM clients.clients c
             LEFT JOIN wialon.objects o ON c.id = o.client_id
             LEFT JOIN clients.client_documents cd ON c.id = cd.client_id
             WHERE c.id = $1
             GROUP BY c.id`,
            [clientId]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Отримання об'єктів клієнта
    static async getClientObjects(clientId) {
        const result = await pool.query(
            `SELECT 
                o.id, o.wialon_id, o.name, o.description, o.status,
                t.name as tariff_name, t.price as tariff_price,
                ot.effective_from as tariff_from
             FROM wialon.objects o
             LEFT JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
             LEFT JOIN billing.tariffs t ON ot.tariff_id = t.id
             WHERE o.client_id = $1
             ORDER BY o.name`,
            [clientId]
        );

        return result.rows;
    }

    // Отримання рахунків клієнта з фільтрами та пагінацією
    static async getClientInvoices(clientId, filters = {}, page = 1, limit = 10) {
        const offset = (page - 1) * limit;

        // Побудова WHERE умов
        let whereConditions = ['i.client_id = $1'];
        let queryParams = [clientId];
        let paramIndex = 2;

        if (filters.status) {
            whereConditions.push(`i.status = $${paramIndex}`);
            queryParams.push(filters.status);
            paramIndex++;
        }

        if (filters.year) {
            whereConditions.push(`i.billing_year = $${paramIndex}`);
            queryParams.push(parseInt(filters.year));
            paramIndex++;
        }

        if (filters.month) {
            whereConditions.push(`i.billing_month = $${paramIndex}`);
            queryParams.push(parseInt(filters.month));
            paramIndex++;
        }

        const whereClause = whereConditions.join(' AND ');

        // Запит рахунків з пагінацією
        const invoicesQuery = `
            SELECT 
                i.id, i.invoice_number, i.invoice_date, i.billing_month, 
                i.billing_year, i.total_amount, i.status, i.created_at,
                p.payment_date, p.amount as paid_amount
            FROM services.invoices i
            LEFT JOIN billing.payments p ON i.payment_id = p.id
            WHERE ${whereClause}
            ORDER BY i.billing_year DESC, i.billing_month DESC, i.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        queryParams.push(limit, offset);

        // Запит для підрахунку загальної кількості
        const countQuery = `SELECT COUNT(*) FROM services.invoices i WHERE ${whereClause}`;
        const countParams = queryParams.slice(0, -2); // Без limit та offset

        const [invoicesResult, countResult] = await Promise.all([
            pool.query(invoicesQuery, queryParams),
            pool.query(countQuery, countParams)
        ]);

        return {
            invoices: invoicesResult.rows,
            pagination: {
                page,
                limit,
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(countResult.rows[0].count / limit)
            }
        };
    }

    // Отримання деталей конкретного рахунку
    static async getInvoiceDetails(invoiceId, clientId) {
        // Отримання основної інформації про рахунок
        const invoiceResult = await pool.query(
            `SELECT 
                i.id, i.invoice_number, i.invoice_date, i.billing_month, 
                i.billing_year, i.total_amount, i.status, i.created_at,
                p.payment_date, p.amount as paid_amount
            FROM services.invoices i
            LEFT JOIN billing.payments p ON i.payment_id = p.id
            WHERE i.id = $1 AND i.client_id = $2`,
            [invoiceId, clientId]
        );

        if (invoiceResult.rows.length === 0) {
            return null;
        }

        const invoice = invoiceResult.rows[0];

        // Отримання позицій рахунку
        const itemsResult = await pool.query(
            `SELECT 
                ii.id, ii.service_id, ii.quantity, ii.unit_price, ii.total_price,
                ii.description, s.name as service_name
            FROM services.invoice_items ii
            LEFT JOIN services.services s ON ii.service_id = s.id
            WHERE ii.invoice_id = $1
            ORDER BY ii.id`,
            [invoiceId]
        );

        invoice.items = itemsResult.rows;
        return invoice;
    }

    // Отримання позицій рахунку
    static async getInvoiceItems(invoiceId, clientId) {
        // Перевірка належності рахунку клієнту
        const invoiceCheck = await pool.query(
            'SELECT id FROM services.invoices WHERE id = $1 AND client_id = $2',
            [invoiceId, clientId]
        );

        if (invoiceCheck.rows.length === 0) {
            return null;
        }

        const result = await pool.query(
            `SELECT 
                ii.id, ii.service_id, ii.quantity, ii.unit_price, ii.total_price,
                ii.description, s.name as service_name
            FROM services.invoice_items ii
            LEFT JOIN services.services s ON ii.service_id = s.id
            WHERE ii.invoice_id = $1
            ORDER BY ii.id`,
            [invoiceId]
        );

        return result.rows;
    }

    // Отримання документів клієнта
    static async getClientDocuments(clientId) {
        const result = await pool.query(
            `SELECT 
                cd.id, cd.document_name, cd.document_type, cd.file_path,
                cd.file_size, cd.description, cd.created_at
             FROM clients.client_documents cd
             WHERE cd.client_id = $1
             ORDER BY cd.created_at DESC`,
            [clientId]
        );

        return result.rows;
    }

    // Отримання заявок клієнта з фільтрами та пагінацією
    static async getClientTickets(clientId, filters = {}, page = 1, limit = 10) {
        const offset = (page - 1) * limit;

        // Побудова WHERE умов
        let whereConditions = ['t.client_id = $1'];
        let queryParams = [clientId];
        let paramIndex = 2;

        if (filters.status) {
            whereConditions.push(`t.status = $${paramIndex}`);
            queryParams.push(filters.status);
            paramIndex++;
        }

        if (filters.priority) {
            whereConditions.push(`t.priority = $${paramIndex}`);
            queryParams.push(filters.priority);
            paramIndex++;
        }

        if (filters.category_id) {
            whereConditions.push(`t.category_id = $${paramIndex}`);
            queryParams.push(filters.category_id);
            paramIndex++;
        }

        const whereClause = whereConditions.join(' AND ');

        // Запит заявок з пагінацією
        const ticketsQuery = `
            SELECT 
                t.id, t.ticket_number, t.title, t.description, t.priority, t.status,
                t.created_at, t.resolved_at, t.closed_at,
                tc.name as category_name, tc.color as category_color,
                wo.name as object_name,
                COUNT(tcm.id) FILTER (WHERE tcm.is_internal = false) as comments_count
            FROM tickets.tickets t
            LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
            LEFT JOIN wialon.objects wo ON t.object_id = wo.id
            LEFT JOIN tickets.ticket_comments tcm ON t.id = tcm.ticket_id
            WHERE ${whereClause}
            GROUP BY t.id, tc.name, tc.color, wo.name
            ORDER BY t.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        queryParams.push(limit, offset);

        // Запит для підрахунку загальної кількості
        const countQuery = `SELECT COUNT(*) FROM tickets.tickets t WHERE ${whereClause}`;
        const countParams = queryParams.slice(0, -2);

        const [ticketsResult, countResult] = await Promise.all([
            pool.query(ticketsQuery, queryParams),
            pool.query(countQuery, countParams)
        ]);

        return {
            tickets: ticketsResult.rows,
            pagination: {
                page,
                limit,
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(countResult.rows[0].count / limit)
            }
        };
    }

    // Отримання документів рахунку
    static async getInvoiceDocuments(invoiceId, clientId) {
        // Перевірка належності рахунку клієнту
        const invoiceCheck = await pool.query(
            'SELECT id FROM services.invoices WHERE id = $1 AND client_id = $2',
            [invoiceId, clientId]
        );

        if (invoiceCheck.rows.length === 0) {
            return null;
        }

        const result = await pool.query(
            `SELECT 
                id, document_name, document_type, file_size, created_at
            FROM services.invoice_documents 
            WHERE invoice_id = $1
            ORDER BY created_at DESC`,
            [invoiceId]
        );

        return result.rows;
    }

    // Отримання документа рахунку для завантаження
    static async getInvoiceDocumentForDownload(documentId, clientId) {
        const result = await pool.query(
            `SELECT 
                id.document_name, id.file_path, id.document_type
            FROM services.invoice_documents id
            JOIN services.invoices i ON id.invoice_id = i.id
            WHERE id.id = $1 AND i.client_id = $2`,
            [documentId, clientId]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Створення заявки клієнтом
    static async createClientTicket(client, clientId, data) {
        const { title, description, category_id, object_id, priority = 'medium' } = data;

        // Валідація об'єкта якщо вказано
        if (object_id) {
            const objectCheck = await client.query(
                'SELECT id FROM wialon.objects WHERE id = $1 AND client_id = $2',
                [object_id, clientId]
            );
            
            if (objectCheck.rows.length === 0) {
                throw new Error('Object not found or access denied');
            }
        }

        // Генерація номера заявки
        const ticketNumber = await this.generateTicketNumber();

        // Створення заявки
        const result = await client.query(
            `INSERT INTO tickets.tickets 
             (ticket_number, client_id, category_id, object_id, title, description, priority, created_by, created_by_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'client')
             RETURNING *`,
            [ticketNumber, clientId, category_id, object_id, title, description, priority, clientId]
        );

        const ticket = result.rows[0];

        // Створення початкового коментаря з описом заявки
        if (description) {
            await client.query(
                `INSERT INTO tickets.ticket_comments 
                 (ticket_id, comment_text, created_by, created_by_type)
                 VALUES ($1, $2, $3, 'client')`,
                [ticket.id, description, clientId]
            );
        }

        return ticket;
    }

    // Генерація унікального номера заявки
    static async generateTicketNumber() {
        const year = new Date().getFullYear();
        const result = await pool.query(
            'SELECT COUNT(*) as count FROM tickets.tickets WHERE EXTRACT(YEAR FROM created_at) = $1',
            [year]
        );
        const count = parseInt(result.rows[0].count) + 1;
        return `T${year}-${count.toString().padStart(4, '0')}`;
    }

    // Отримання статистики клієнта для дашборду
    static async getClientDashboardStats(clientId) {
        const result = await pool.query(
            `SELECT 
                (SELECT COUNT(*) FROM wialon.objects WHERE client_id = $1) as objects_count,
                (SELECT COUNT(*) FROM tickets.tickets WHERE client_id = $1) as total_tickets,
                (SELECT COUNT(*) FROM tickets.tickets WHERE client_id = $1 AND status = 'open') as open_tickets,
                (SELECT COUNT(*) FROM tickets.tickets WHERE client_id = $1 AND status IN ('resolved', 'closed')) as resolved_tickets,
                (SELECT COUNT(*) FROM services.invoices WHERE client_id = $1 AND status = 'unpaid') as unpaid_invoices,
                (SELECT COALESCE(SUM(total_amount), 0) FROM services.invoices WHERE client_id = $1 AND status = 'unpaid') as total_debt,
                (SELECT COUNT(*) FROM clients.client_documents WHERE client_id = $1) as documents_count`,
            [clientId]
        );

        return result.rows[0];
    }
}

module.exports = PortalService;