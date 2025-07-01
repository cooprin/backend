const { pool } = require('../database');

class TicketCommentsService {
    // Перевірка доступу до заявки
    static async checkTicketAccess(ticketId, userType, clientId = null) {
        let ticketQuery, ticketParams;
        
        if (userType === 'client') {
            ticketQuery = 'SELECT id, client_id FROM tickets.tickets WHERE id = $1 AND client_id = $2';
            ticketParams = [ticketId, clientId];
        } else {
            ticketQuery = 'SELECT id, client_id FROM tickets.tickets WHERE id = $1';
            ticketParams = [ticketId];
        }

        const result = await pool.query(ticketQuery, ticketParams);
        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Отримання коментарів заявки
    static async getTicketComments(ticketId, userType) {
        let commentsQuery = `
            SELECT 
                tc.id, tc.comment_text, tc.is_internal, tc.created_by, tc.created_by_type, tc.created_at,
                CASE 
                    WHEN tc.created_by_type = 'client' THEN c.name
                    WHEN tc.created_by_type = 'staff' THEN u.first_name || ' ' || u.last_name
                END as author_name
            FROM tickets.ticket_comments tc
            LEFT JOIN clients.clients c ON (tc.created_by_type = 'client' AND tc.created_by = c.id)
            LEFT JOIN auth.users u ON (tc.created_by_type = 'staff' AND tc.created_by = u.id)
            WHERE tc.ticket_id = $1`;

        // Приховуємо внутрішні коментарі від клієнтів
        if (userType === 'client') {
            commentsQuery += ' AND tc.is_internal = false';
        }

        commentsQuery += ' ORDER BY tc.created_at ASC';

        const result = await pool.query(commentsQuery, [ticketId]);
        return result.rows;
    }

    // Створення коментаря
    static async createComment(client, ticketId, commentText, userType, userId, isInternal = false) {
        // Визначення автора коментаря
        let createdBy, createdByType, finalIsInternal;
        
        if (userType === 'client') {
            createdBy = userId; // для клієнта це clientId
            createdByType = 'client';
            finalIsInternal = false; // Клієнти не можуть створювати внутрішні коментарі
        } else {
            createdBy = userId;
            createdByType = 'staff';
            finalIsInternal = isInternal;
        }

        const result = await client.query(
            `INSERT INTO tickets.ticket_comments 
             (ticket_id, comment_text, is_internal, created_by, created_by_type)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [ticketId, commentText.trim(), finalIsInternal, createdBy, createdByType]
        );

        const comment = result.rows[0];

        // Отримання імені автора для відповіді
        let authorName;
        if (createdByType === 'client') {
            const clientResult = await pool.query('SELECT name FROM clients.clients WHERE id = $1', [createdBy]);
            authorName = clientResult.rows[0]?.name;
        } else {
            const userResult = await pool.query('SELECT first_name, last_name FROM auth.users WHERE id = $1', [createdBy]);
            const user = userResult.rows[0];
            authorName = user ? `${user.first_name} ${user.last_name}` : null;
        }

        // Оновлення статусу заявки якщо потрібно
        if (userType === 'client') {
            // Якщо клієнт додає коментар і заявка "waiting_client", змінюємо на "open"
            await client.query(
                `UPDATE tickets.tickets 
                 SET status = CASE WHEN status = 'waiting_client' THEN 'open' ELSE status END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [ticketId]
            );
        }

        return {
            ...comment,
            author_name: authorName
        };
    }

    // Оновлення коментаря
    static async updateComment(commentId, commentText, userType, userId) {
        let whereClause = 'WHERE tc.id = $1';
        let queryParams = [commentId];

        if (userType === 'client') {
            whereClause += ' AND tc.created_by = $2 AND tc.created_by_type = $3';
            queryParams.push(userId, 'client'); // для клієнта userId це clientId
        }
        // Співробітники можуть редагувати будь-який коментар

        const result = await pool.query(
            `UPDATE tickets.ticket_comments tc
             SET comment_text = $${queryParams.length + 1}, updated_at = CURRENT_TIMESTAMP
             ${whereClause}
             RETURNING *`,
            [...queryParams, commentText.trim()]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Видалення коментаря
    static async deleteComment(commentId, userType, userId) {
        let whereClause = 'WHERE id = $1';
        let queryParams = [commentId];

        if (userType === 'client') {
            whereClause += ' AND created_by = $2 AND created_by_type = $3';
            queryParams.push(userId, 'client'); // для клієнта userId це clientId
        }
        // Співробітники можуть видаляти будь-який коментар

        const result = await pool.query(
            `DELETE FROM tickets.ticket_comments ${whereClause} RETURNING *`,
            queryParams
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Отримання статистики коментарів заявки
    static async getTicketCommentsStats(ticketId, userType) {
        let commentsQuery = `
            SELECT 
                COUNT(*) as total_comments,
                COUNT(CASE WHEN created_by_type = 'client' THEN 1 END) as client_comments,
                COUNT(CASE WHEN created_by_type = 'staff' THEN 1 END) as staff_comments,
                COUNT(CASE WHEN is_internal = true THEN 1 END) as internal_comments,
                MAX(created_at) as last_comment_at
            FROM tickets.ticket_comments 
            WHERE ticket_id = $1`;

        // Для клієнтів не враховуємо внутрішні коментарі
        if (userType === 'client') {
            commentsQuery += ' AND is_internal = false';
        }

        const result = await pool.query(commentsQuery, [ticketId]);
        return result.rows[0];
    }

    // Пошук коментарів
    static async searchComments(searchTerm, userType, clientId = null, limit = 50) {
        let searchQuery = `
            SELECT 
                tc.id, tc.ticket_id, tc.comment_text, tc.is_internal, 
                tc.created_by, tc.created_by_type, tc.created_at,
                t.ticket_number, t.title as ticket_title,
                CASE 
                    WHEN tc.created_by_type = 'client' THEN c.name
                    WHEN tc.created_by_type = 'staff' THEN u.first_name || ' ' || u.last_name
                END as author_name
            FROM tickets.ticket_comments tc
            JOIN tickets.tickets t ON tc.ticket_id = t.id
            LEFT JOIN clients.clients c ON (tc.created_by_type = 'client' AND tc.created_by = c.id)
            LEFT JOIN auth.users u ON (tc.created_by_type = 'staff' AND tc.created_by = u.id)
            WHERE tc.comment_text ILIKE $1`;

        let queryParams = [`%${searchTerm}%`];

        // Фільтр для клієнтів
        if (userType === 'client') {
            searchQuery += ' AND t.client_id = $2 AND tc.is_internal = false';
            queryParams.push(clientId);
        }

        searchQuery += ' ORDER BY tc.created_at DESC LIMIT $' + (queryParams.length + 1);
        queryParams.push(limit);

        const result = await pool.query(searchQuery, queryParams);
        return result.rows;
    }

    // Отримання останніх коментарів користувача
    static async getUserRecentComments(userType, userId, limit = 10) {
        let recentQuery = `
            SELECT 
                tc.id, tc.ticket_id, tc.comment_text, tc.created_at,
                t.ticket_number, t.title as ticket_title, t.status as ticket_status
            FROM tickets.ticket_comments tc
            JOIN tickets.tickets t ON tc.ticket_id = t.id
            WHERE tc.created_by = $1 AND tc.created_by_type = $2`;

        let queryParams = [userId, userType];

        // Для клієнтів додаємо фільтр по client_id
        if (userType === 'client') {
            recentQuery += ' AND t.client_id = $1'; // userId для клієнта це clientId
        }

        recentQuery += ' ORDER BY tc.created_at DESC LIMIT $' + (queryParams.length + 1);
        queryParams.push(limit);

        const result = await pool.query(recentQuery, queryParams);
        return result.rows;
    }

    // Масове видалення коментарів (тільки для співробітників)
    static async bulkDeleteComments(commentIds, userId) {
        const placeholders = commentIds.map((_, index) => `$${index + 1}`).join(',');
        
        const result = await pool.query(
            `DELETE FROM tickets.ticket_comments 
             WHERE id IN (${placeholders})
             RETURNING id, ticket_id, comment_text, created_by, created_by_type`,
            commentIds
        );

        return result.rows;
    }

    // Отримання коментарів з можливістю редагування
    static async getEditableComments(ticketId, userType, userId) {
        let commentsQuery = `
            SELECT 
                tc.id, tc.comment_text, tc.is_internal, tc.created_by, tc.created_by_type, 
                tc.created_at, tc.updated_at,
                CASE 
                    WHEN tc.created_by_type = 'client' THEN c.name
                    WHEN tc.created_by_type = 'staff' THEN u.first_name || ' ' || u.last_name
                END as author_name,
                CASE 
                    WHEN tc.created_by_type = $2 AND tc.created_by = $3 THEN true
                    WHEN $2 = 'staff' THEN true
                    ELSE false
                END as can_edit,
                CASE 
                    WHEN tc.created_by_type = $2 AND tc.created_by = $3 THEN true
                    WHEN $2 = 'staff' THEN true
                    ELSE false
                END as can_delete
            FROM tickets.ticket_comments tc
            LEFT JOIN clients.clients c ON (tc.created_by_type = 'client' AND tc.created_by = c.id)
            LEFT JOIN auth.users u ON (tc.created_by_type = 'staff' AND tc.created_by = u.id)
            WHERE tc.ticket_id = $1`;

        let queryParams = [ticketId, userType, userId];

        // Приховуємо внутрішні коментарі від клієнтів
        if (userType === 'client') {
            commentsQuery += ' AND tc.is_internal = false';
        }

        commentsQuery += ' ORDER BY tc.created_at ASC';

        const result = await pool.query(commentsQuery, queryParams);
        return result.rows;
    }
}

module.exports = TicketCommentsService;