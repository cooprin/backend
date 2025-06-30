const { pool } = require('../database');

class TicketService {
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

    // Отримання списку співробітників
    static async getStaffList() {
        const result = await pool.query(
            `SELECT 
                u.id, 
                u.first_name, 
                u.last_name, 
                u.email,
                u.is_active,
                COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) as roles
             FROM auth.users u 
             LEFT JOIN auth.user_roles ur ON u.id = ur.user_id
             LEFT JOIN auth.roles r ON ur.role_id = r.id
             WHERE u.is_active = true
             GROUP BY u.id, u.first_name, u.last_name, u.email, u.is_active
             ORDER BY u.first_name, u.last_name`
        );

        return result.rows.map(user => ({
            id: user.id,
            label: `${user.first_name} ${user.last_name}`,
            value: user.id,
            email: user.email,
            roles: user.roles || [],
            department: (user.roles && user.roles.includes('admin')) ? 'Administration' : 'Support'
        }));
    }

    // Отримання метрик заявок для дашборду
    static async getTicketsMetrics() {
        const result = await pool.query(`
            SELECT 
                COUNT(CASE WHEN status = 'open' THEN 1 END) as new_count,
                COUNT(CASE WHEN status IN ('in_progress', 'waiting_client') THEN 1 END) as in_progress_count,
                COUNT(CASE WHEN priority = 'urgent' AND status NOT IN ('resolved', 'closed', 'cancelled') THEN 1 END) as urgent_count,
                COUNT(CASE WHEN status = 'resolved' AND DATE(resolved_at) = CURRENT_DATE THEN 1 END) as resolved_today_count
            FROM tickets.tickets
        `);

        return result.rows[0];
    }

    // Отримання розподілу заявок по статусах
    static async getStatusDistribution() {
        const result = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count
            FROM tickets.tickets
            GROUP BY status
            ORDER BY count DESC
        `);

        return result.rows;
    }

    // Отримання останніх заявок
    static async getRecentTickets(limit = 10) {
        const result = await pool.query(`
            SELECT 
                t.id,
                t.ticket_number,
                t.title,
                t.priority,
                t.status,
                t.created_at,
                c.name as client_name
            FROM tickets.tickets t
            JOIN clients.clients c ON t.client_id = c.id
            ORDER BY t.created_at DESC
            LIMIT $1
        `, [limit]);

        return result.rows;
    }

    // Отримання заявок по категоріях
    static async getTicketsByCategory() {
        const result = await pool.query(`
            SELECT 
                tc.id as category_id,
                tc.name as category_name,
                tc.color as category_color,
                COUNT(t.id) as total_count,
                COUNT(CASE WHEN t.status = 'open' THEN 1 END) as new_count,
                COUNT(CASE WHEN t.status IN ('in_progress', 'waiting_client') THEN 1 END) as in_progress_count,
                COUNT(CASE WHEN t.status IN ('resolved', 'closed') THEN 1 END) as resolved_count,
                AVG(
                    CASE 
                        WHEN t.status IN ('resolved', 'closed') AND t.resolved_at IS NOT NULL 
                        THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600
                    END
                ) as avg_resolution_time
            FROM tickets.ticket_categories tc
            LEFT JOIN tickets.tickets t ON tc.id = t.category_id
            WHERE tc.is_active = true
            GROUP BY tc.id, tc.name, tc.color
            ORDER BY total_count DESC
        `);

        return result.rows;
    }

    // Отримання категорій заявок
    static async getTicketCategories() {
        const result = await pool.query(
            'SELECT * FROM tickets.ticket_categories WHERE is_active = true ORDER BY sort_order'
        );

        return result.rows;
    }

    // Масове призначення заявок
    static async bulkAssignTickets(client, ticketIds, assignedTo, comment, userId) {
        if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
            throw new Error('ticket_ids array is required');
        }

        if (!assignedTo) {
            throw new Error('assigned_to is required');
        }

        // Побудова запиту оновлення
        let updateFields = ['assigned_to = $1', 'updated_at = CURRENT_TIMESTAMP'];
        let updateParams = [assignedTo];
        let paramCount = 1;

        // Оновлення всіх заявок
        const placeholders = ticketIds.map((_, index) => `$${++paramCount}`).join(',');
        updateParams.push(...ticketIds);

        const result = await client.query(
            `UPDATE tickets.tickets 
             SET ${updateFields.join(', ')}
             WHERE id IN (${placeholders})
             RETURNING *`,
            updateParams
        );

        // Додавання коментарів якщо надано
        if (comment) {
            for (const ticketId of ticketIds) {
                await client.query(
                    `INSERT INTO tickets.ticket_comments 
                     (ticket_id, comment_text, created_by, created_by_type, is_internal)
                     VALUES ($1, $2, $3, 'staff', true)`,
                    [ticketId, comment, userId]
                );
            }
        }

        return result.rows;
    }

    // Масова зміна статусу заявок
    static async bulkUpdateStatus(client, ticketIds, newStatus, comment, userId, options = {}) {
        if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
            throw new Error('ticket_ids array is required');
        }

        if (!newStatus) {
            throw new Error('new_status is required');
        }

        // Побудова запиту оновлення
        let updateFields = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
        let updateParams = [newStatus];
        let paramCount = 1;

        if (newStatus === 'resolved' && options.set_resolved_date) {
            updateFields.push('resolved_at = CURRENT_TIMESTAMP');
            updateFields.push(`resolved_by = $${++paramCount}`);
            updateParams.push(userId);
        }

        if (newStatus === 'closed' && options.set_closed_date) {
            updateFields.push('closed_at = CURRENT_TIMESTAMP');
            updateFields.push(`closed_by = $${++paramCount}`);
            updateParams.push(userId);
        }

        // Оновлення всіх заявок
        const placeholders = ticketIds.map((_, index) => `$${++paramCount}`).join(',');
        updateParams.push(...ticketIds);

        const result = await client.query(
            `UPDATE tickets.tickets 
             SET ${updateFields.join(', ')}
             WHERE id IN (${placeholders})
             RETURNING *`,
            updateParams
        );

        // Додавання коментарів якщо надано
        if (comment) {
            for (const ticketId of ticketIds) {
                await client.query(
                    `INSERT INTO tickets.ticket_comments 
                     (ticket_id, comment_text, created_by, created_by_type, is_internal)
                     VALUES ($1, $2, $3, 'staff', true)`,
                    [ticketId, comment, userId]
                );
            }
        }

        return result.rows;
    }

    // Масова зміна пріоритету заявок
    static async bulkUpdatePriority(client, ticketIds, newPriority, reason, userId, customDueDate = null) {
        if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
            throw new Error('ticket_ids array is required');
        }

        if (!newPriority) {
            throw new Error('new_priority is required');
        }

        // Побудова запиту оновлення
        let updateFields = ['priority = $1', 'updated_at = CURRENT_TIMESTAMP'];
        let updateParams = [newPriority];
        let paramCount = 1;

        if (customDueDate) {
            updateFields.push(`due_date = $${++paramCount}`);
            updateParams.push(customDueDate);
        }

        // Оновлення всіх заявок
        const placeholders = ticketIds.map((_, index) => `$${++paramCount}`).join(',');
        updateParams.push(...ticketIds);

        const result = await client.query(
            `UPDATE tickets.tickets 
             SET ${updateFields.join(', ')}
             WHERE id IN (${placeholders})
             RETURNING *`,
            updateParams
        );

        // Додавання причини як коментар якщо надано
        if (reason) {
            for (const ticketId of ticketIds) {
                await client.query(
                    `INSERT INTO tickets.ticket_comments 
                     (ticket_id, comment_text, created_by, created_by_type, is_internal)
                     VALUES ($1, $2, $3, 'staff', true)`,
                    [ticketId, `Priority changed to ${newPriority}: ${reason}`, userId]
                );
            }
        }

        return result.rows;
    }

    // Отримання заявок з фільтрами та пагінацією
    static async getTickets(filters = {}, userType, clientId = null, page = 1, limit = 10) {
        const offset = (page - 1) * limit;
        
        let whereClause = '';
        let queryParams = [];
        let paramCount = 0;

        // Фільтр для клієнтів
        if (userType === 'client') {
            whereClause = 'WHERE t.client_id = $1';
            queryParams.push(clientId);
            paramCount = 1;
        }

        // Фільтр статусу
        if (filters.status) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            
            let statuses;
            if (Array.isArray(filters.status)) {
                statuses = filters.status;
            } else if (typeof filters.status === 'string' && filters.status.includes(',')) {
                statuses = filters.status.split(',');
            } else {
                statuses = [filters.status];
            }

            if (statuses.length === 1) {
                whereClause += `t.status = $${++paramCount}`;
                queryParams.push(statuses[0]);
            } else {
                const statusPlaceholders = statuses.map(() => `$${++paramCount}`).join(',');
                whereClause += `t.status IN (${statusPlaceholders})`;
                queryParams.push(...statuses);
            }
        }

        // Фільтр пріоритету
        if (filters.priority) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            
            let priorities;
            if (Array.isArray(filters.priority)) {
                priorities = filters.priority;
            } else if (typeof filters.priority === 'string' && filters.priority.includes(',')) {
                priorities = filters.priority.split(',');
            } else {
                priorities = [filters.priority];
            }

            if (priorities.length === 1) {
                whereClause += `t.priority = $${++paramCount}`;
                queryParams.push(priorities[0]);
            } else {
                const priorityPlaceholders = priorities.map(() => `$${++paramCount}`).join(',');
                whereClause += `t.priority IN (${priorityPlaceholders})`;
                queryParams.push(...priorities);
            }
        }

        // Інші фільтри...
        if (filters.category_id) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            
            let categories;
            if (Array.isArray(filters.category_id)) {
                categories = filters.category_id;
            } else if (typeof filters.category_id === 'string' && filters.category_id.includes(',')) {
                categories = filters.category_id.split(',');
            } else {
                categories = [filters.category_id];
            }

            if (categories.length === 1) {
                whereClause += `t.category_id = $${++paramCount}`;
                queryParams.push(categories[0]);
            } else {
                const categoryPlaceholders = categories.map(() => `$${++paramCount}`).join(',');
                whereClause += `t.category_id IN (${categoryPlaceholders})`;
                queryParams.push(...categories);
            }
        }

        if (filters.assigned_to) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            if (filters.assigned_to === 'unassigned') {
                whereClause += `t.assigned_to IS NULL`;
            } else {
                whereClause += `t.assigned_to = $${++paramCount}`;
                queryParams.push(filters.assigned_to);
            }
        }

        if (filters.client_id && userType === 'staff') {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `t.client_id = $${++paramCount}`;
            queryParams.push(filters.client_id);
        }

        if (filters.search) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `(t.title ILIKE $${++paramCount} OR t.description ILIKE $${++paramCount} OR t.ticket_number ILIKE $${++paramCount} OR c.name ILIKE $${++paramCount})`;
            const searchTerm = `%${filters.search}%`;
            queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        // Фільтри по датах
        if (filters.created_from) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(t.created_at) >= $${++paramCount}`;
            queryParams.push(filters.created_from);
        }

        if (filters.created_to) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(t.created_at) <= $${++paramCount}`;
            queryParams.push(filters.created_to);
        }

        // Додаткові фільтри дат...
        if (filters.date_from) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(t.resolved_at) >= $${++paramCount}`;
            queryParams.push(filters.date_from);
        }

        if (filters.date_to) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(t.resolved_at) <= $${++paramCount}`;
            queryParams.push(filters.date_to);
        }

        if (filters.updated_from) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(t.updated_at) >= $${++paramCount}`;
            queryParams.push(filters.updated_from);
        }

        if (filters.updated_to) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(t.updated_at) <= $${++paramCount}`;
            queryParams.push(filters.updated_to);
        }

        if (filters.resolved_by) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `t.resolved_by = $${++paramCount}`;
            queryParams.push(filters.resolved_by);
        }

        // Сортування
        let orderBy = 'ORDER BY t.created_at DESC'; // за замовчуванням
        if (filters.sortBy) {
            const allowedSortFields = [
                'created_at', 'updated_at', 'resolved_at', 'title', 'ticket_number', 
                'priority', 'status', 'client_name', 'assigned_to_name'
            ];
            
            if (allowedSortFields.includes(filters.sortBy)) {
                const direction = filters.sortDesc === 'true' ? 'DESC' : 'ASC';
                
                if (filters.sortBy === 'client_name') {
                    orderBy = `ORDER BY c.name ${direction}`;
                } else if (filters.sortBy === 'assigned_to_name') {
                    orderBy = `ORDER BY u.first_name ${direction}, u.last_name ${direction}`;
                } else {
                    orderBy = `ORDER BY t.${filters.sortBy} ${direction}`;
                }
            }
        }

        // Додавання limit та offset
        queryParams.push(limit, offset);

        const ticketsQuery = `
            SELECT 
                t.*, 
                c.name as client_name,
                c.email as client_email,
                tc.name as category_name, 
                tc.color as category_color,
                wo.name as object_name,
                u.first_name || ' ' || u.last_name as assigned_to_name,
                ur.first_name || ' ' || ur.last_name as resolved_by_name,
                COUNT(tcm.id) as comments_count,
                (
                    SELECT json_build_object(
                        'id', last_comment.id,
                        'comment_text', last_comment.comment_text,
                        'created_at', last_comment.created_at,
                        'author_name', 
                        CASE 
                            WHEN last_comment.created_by_type = 'client' THEN lc_client.name
                            ELSE lc_user.first_name || ' ' || lc_user.last_name
                        END,
                        'created_by_type', last_comment.created_by_type
                    )
                    FROM tickets.ticket_comments last_comment
                    LEFT JOIN clients.clients lc_client ON last_comment.created_by_type = 'client' AND last_comment.created_by::text = lc_client.id::text
                    LEFT JOIN auth.users lc_user ON last_comment.created_by_type = 'staff' AND last_comment.created_by = lc_user.id
                    WHERE last_comment.ticket_id = t.id 
                        ${userType === 'client' ? 'AND last_comment.is_internal = false' : ''}
                    ORDER BY last_comment.created_at DESC 
                    LIMIT 1
                ) as last_comment
             FROM tickets.tickets t
             JOIN clients.clients c ON t.client_id = c.id
             LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
             LEFT JOIN wialon.objects wo ON t.object_id = wo.id
             LEFT JOIN auth.users u ON t.assigned_to = u.id
             LEFT JOIN auth.users ur ON t.resolved_by = ur.id
             LEFT JOIN tickets.ticket_comments tcm ON t.id = tcm.ticket_id 
                 ${userType === 'client' ? 'AND tcm.is_internal = false' : ''}
             ${whereClause}
             GROUP BY t.id, c.name, c.email, tc.name, tc.color, wo.name, u.first_name, u.last_name, ur.first_name, ur.last_name
             ${orderBy}
             LIMIT $${++paramCount} OFFSET $${++paramCount}
        `;

        // Запит для підрахунку загальної кількості
        const countParams = queryParams.slice(0, -2);
        const countQuery = `
            SELECT COUNT(DISTINCT t.id) as count
            FROM tickets.tickets t
            JOIN clients.clients c ON t.client_id = c.id
            LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
            LEFT JOIN wialon.objects wo ON t.object_id = wo.id
            LEFT JOIN auth.users u ON t.assigned_to = u.id
            LEFT JOIN auth.users ur ON t.resolved_by = ur.id
            ${whereClause}
        `;

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

    // Отримання конкретної заявки
    static async getTicketById(ticketId, userType, clientId = null) {
        let whereClause = 'WHERE t.id = $1';
        let queryParams = [ticketId];

        if (userType === 'client') {
            whereClause += ' AND t.client_id = $2';
            queryParams.push(clientId);
        }

        const result = await pool.query(
            `SELECT 
                t.*, 
                c.name as client_name, c.email as client_email,
                tc.name as category_name, tc.color as category_color,
                wo.name as object_name,
                u.first_name || ' ' || u.last_name as assigned_to_name,
                ur.first_name || ' ' || ur.last_name as resolved_by_name
             FROM tickets.tickets t
             JOIN clients.clients c ON t.client_id = c.id
             LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
             LEFT JOIN wialon.objects wo ON t.object_id = wo.id
             LEFT JOIN auth.users u ON t.assigned_to = u.id
             LEFT JOIN auth.users ur ON t.resolved_by = ur.id
             ${whereClause}`,
            queryParams
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Створення заявки
    static async createTicket(client, data, userType, userId) {
        const { title, description, category_id, object_id, priority = 'medium', assigned_to, client_id } = data;

        // Визначення clientId, createdBy, та createdByType
        let finalClientId, createdBy, createdByType;
        
        if (userType === 'client') {
            finalClientId = userId; // для клієнта userId це clientId
            createdBy = userId;
            createdByType = 'client';

            // Валідація об'єкта якщо вказано
            if (object_id) {
                const objectCheck = await client.query(
                    'SELECT id FROM wialon.objects WHERE id = $1 AND client_id = $2',
                    [object_id, userId]
                );
                
                if (objectCheck.rows.length === 0) {
                    throw new Error('Object not found or access denied');
                }
            }
        } else {
            // Співробітник створює заявку
            finalClientId = client_id;
            createdBy = userId;
            createdByType = 'staff';
            
            if (!finalClientId) {
                throw new Error('client_id is required');
            }

            // Валідація клієнта
            const clientCheck = await client.query(
                'SELECT id FROM clients.clients WHERE id = $1',
                [finalClientId]
            );
            
            if (clientCheck.rows.length === 0) {
                throw new Error('Client not found');
            }
        }

        const ticketNumber = await this.generateTicketNumber();

        const result = await client.query(
            `INSERT INTO tickets.tickets 
             (ticket_number, client_id, category_id, object_id, title, description, priority, assigned_to, created_by, created_by_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [ticketNumber, finalClientId, category_id, object_id, title, description, priority, assigned_to, createdBy, createdByType]
        );

        const ticket = result.rows[0];

        // Створення початкового коментаря з описом заявки
        if (description) {
            await client.query(
                `INSERT INTO tickets.ticket_comments 
                 (ticket_id, comment_text, created_by, created_by_type)
                 VALUES ($1, $2, $3, $4)`,
                [ticket.id, description, createdBy, createdByType]
            );
        }

        return ticket;
    }

    // Оновлення заявки
    static async updateTicket(ticketId, data, userId) {
        const { status, priority, assigned_to, category_id } = data;
        
        // Побудова динамічного запиту оновлення
        let updateFields = [];
        let updateValues = [];
        let paramCount = 0;

        if (status !== undefined) {
            updateFields.push(`status = $${++paramCount}`);
            updateValues.push(status);
        }

        if (priority !== undefined) {
            updateFields.push(`priority = $${++paramCount}`);
            updateValues.push(priority);
        }

        if (assigned_to !== undefined) {
            updateFields.push(`assigned_to = $${++paramCount}`);
            updateValues.push(assigned_to);
        }

        if (category_id !== undefined) {
            updateFields.push(`category_id = $${++paramCount}`);
            updateValues.push(category_id);
        }

        // Завжди оновлюємо updated_at
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        // Обробка resolved_at та closed_at в залежності від статусу
        if (status === 'resolved') {
            updateFields.push(`resolved_at = CURRENT_TIMESTAMP`);
            updateFields.push(`resolved_by = $${++paramCount}`);
            updateValues.push(userId);
        } else if (status === 'closed') {
            updateFields.push(`closed_at = CURRENT_TIMESTAMP`);
            updateFields.push(`closed_by = $${++paramCount}`);
            updateValues.push(userId);
        }

        // Додаємо ID заявки як останній параметр
        updateValues.push(ticketId);

        const result = await pool.query(
            `UPDATE tickets.tickets 
             SET ${updateFields.join(', ')}
             WHERE id = $${++paramCount}
             RETURNING *`,
            updateValues
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }
}

module.exports = TicketService;