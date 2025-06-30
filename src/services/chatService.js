const { pool } = require('../database');

class ChatService {
    // Отримання активного чату для клієнта
    static async getActiveClientChat(clientId) {
        const query = `
            SELECT 
                cr.id, cr.client_id, cr.ticket_id, cr.room_type, cr.assigned_staff_id,
                cr.room_status, cr.last_message_at, cr.created_at,
                t.ticket_number, t.title as ticket_title,
                u.first_name || ' ' || u.last_name as assigned_staff_name,
                COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'staff') as unread_staff_messages
            FROM chat.chat_rooms cr
            LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
            LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
            LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
            WHERE cr.client_id = $1 AND cr.room_status = 'active'
            GROUP BY cr.id, t.ticket_number, t.title, u.first_name, u.last_name
            ORDER BY cr.last_message_at DESC NULLS LAST, cr.created_at DESC
            LIMIT 1
        `;

        const result = await pool.query(query, [clientId]);
        return {
            activeRoom: result.rows.length > 0 ? result.rows[0] : null,
            hasActiveChat: result.rows.length > 0
        };
    }

    // Отримання всіх чат-кімнат клієнта
    static async getClientRooms(clientId) {
        const query = `
            SELECT 
                cr.id, cr.client_id, cr.ticket_id, cr.room_type, cr.assigned_staff_id,
                cr.room_status, cr.last_message_at, cr.created_at,
                t.ticket_number, t.title as ticket_title,
                u.first_name || ' ' || u.last_name as assigned_staff_name,
                COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'staff') as unread_staff_messages
            FROM chat.chat_rooms cr
            LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
            LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
            LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
            WHERE cr.client_id = $1
            GROUP BY cr.id, t.ticket_number, t.title, u.first_name, u.last_name
            ORDER BY cr.last_message_at DESC NULLS LAST, cr.created_at DESC
        `;

        const result = await pool.query(query, [clientId]);
        return result.rows;
    }

    // Створення нової чат-кімнати
    static async createChatRoom(client, clientId, data) {
        const { room_type = 'support', ticket_id } = data;

        // Перевіряємо чи є активний чат
        const existingChatCheck = await client.query(
            'SELECT id FROM chat.chat_rooms WHERE client_id = $1 AND room_status = $2',
            [clientId, 'active']
        );

        if (existingChatCheck.rows.length > 0) {
            throw new Error('У вас вже є активний чат з підтримкою');
        }

        // Валідація тікета якщо вказано
        if (ticket_id) {
            const ticketCheck = await client.query(
                'SELECT id FROM tickets.tickets WHERE id = $1 AND client_id = $2',
                [ticket_id, clientId]
            );
            
            if (ticketCheck.rows.length === 0) {
                throw new Error('Ticket not found or access denied');
            }
        }

        const result = await client.query(
            `INSERT INTO chat.chat_rooms (client_id, ticket_id, room_type, room_status)
             VALUES ($1, $2, $3, 'active')
             RETURNING *`,
            [clientId, ticket_id, room_type]
        );

        return result.rows[0];
    }

    // Перевірка доступу до кімнати
    static async checkRoomAccess(roomId, userType, userId) {
        let roomCheck;
        
        if (userType === 'client') {
            roomCheck = await pool.query(
                'SELECT id, client_id FROM chat.chat_rooms WHERE id = $1 AND client_id = $2',
                [roomId, userId]
            );
        } else {
            roomCheck = await pool.query(
                'SELECT id, client_id FROM chat.chat_rooms WHERE id = $1',
                [roomId]
            );
        }

        return roomCheck.rows.length > 0 ? roomCheck.rows[0] : null;
    }

    // Отримання повідомлень з пагінацією
    static async getRoomMessages(roomId, page = 1, limit = 20) {
        const offset = (page - 1) * limit;

        const messagesQuery = `
            SELECT 
                cm.id, cm.room_id, cm.message_text, cm.sender_id, cm.sender_type,
                cm.is_read, cm.read_at, cm.external_platform, cm.created_at,
                CASE 
                    WHEN cm.sender_type = 'client' THEN c.name
                    WHEN cm.sender_type = 'staff' THEN u.first_name || ' ' || u.last_name
                END as sender_name
            FROM chat.chat_messages cm
            LEFT JOIN clients.clients c ON (cm.sender_type = 'client' AND cm.sender_id = c.id)
            LEFT JOIN auth.users u ON (cm.sender_type = 'staff' AND cm.sender_id = u.id)
            WHERE cm.room_id = $1
            ORDER BY cm.created_at ASC
            LIMIT $2 OFFSET $3
        `;

        const [messagesResult, countResult] = await Promise.all([
            pool.query(messagesQuery, [roomId, limit, offset]),
            pool.query('SELECT COUNT(*) FROM chat.chat_messages WHERE room_id = $1', [roomId])
        ]);

        return {
            messages: messagesResult.rows,
            pagination: {
                page,
                limit,
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(countResult.rows[0].count / limit)
            }
        };
    }

    // Відправка повідомлення
    static async sendMessage(client, roomId, messageText, senderId, senderType) {
        // Вставка повідомлення
        const messageResult = await client.query(
            `INSERT INTO chat.chat_messages (room_id, message_text, sender_id, sender_type)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [roomId, messageText.trim(), senderId, senderType]
        );

        // Оновлення часу останнього повідомлення
        await client.query(
            'UPDATE chat.chat_rooms SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1',
            [roomId]
        );

        // Отримання імені відправника
        let senderName;
        if (senderType === 'client') {
            const clientResult = await client.query('SELECT name FROM clients.clients WHERE id = $1', [senderId]);
            senderName = clientResult.rows[0]?.name;
        } else {
            const userResult = await client.query('SELECT first_name, last_name FROM auth.users WHERE id = $1', [senderId]);
            const user = userResult.rows[0];
            senderName = user ? `${user.first_name} ${user.last_name}` : null;
        }

        return {
            ...messageResult.rows[0],
            sender_name: senderName
        };
    }

    // Позначити повідомлення як прочитані
    static async markMessagesAsRead(roomId, userType) {
        let updateQuery;
        let queryParams;

        if (userType === 'client') {
            // Клієнт позначає повідомлення співробітників як прочитані
            updateQuery = `
                UPDATE chat.chat_messages 
                SET is_read = true, read_at = CURRENT_TIMESTAMP
                WHERE room_id = $1 AND sender_type = 'staff' AND is_read = false
            `;
            queryParams = [roomId];
        } else {
            // Співробітник позначає повідомлення клієнтів як прочитані
            updateQuery = `
                UPDATE chat.chat_messages 
                SET is_read = true, read_at = CURRENT_TIMESTAMP
                WHERE room_id = $1 AND sender_type = 'client' AND is_read = false
            `;
            queryParams = [roomId];
        }

        await pool.query(updateQuery, queryParams);
    }

    // Отримання статусу співробітників
    static async getStaffStatus() {
        const result = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, 
                    false as is_online, 
                    CURRENT_TIMESTAMP - INTERVAL '5 minutes' as last_seen
             FROM auth.users u
             JOIN auth.user_roles ur ON u.id = ur.user_id
             JOIN auth.role_permissions rp ON ur.role_id = rp.role_id
             JOIN auth.permissions p ON rp.permission_id = p.id
             WHERE p.code = 'chat.read'
             AND u.is_active = true`
        );

        return result.rows;
    }

    // Закриття чат-кімнати
    static async closeChatRoom(roomId, staffId) {
        const result = await pool.query(
            `UPDATE chat.chat_rooms 
             SET room_status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = $1
             WHERE id = $2
             RETURNING *`,
            [staffId, roomId]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Призначення чату співробітнику
    static async assignChatRoom(roomId, staffId) {
        const result = await pool.query(
            `UPDATE chat.chat_rooms 
             SET assigned_staff_id = $1
             WHERE id = $2
             RETURNING *`,
            [staffId, roomId]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Видалення чат-кімнати
    static async deleteChatRoom(client, roomId) {
        // Перевіряємо чи існує кімната
        const roomCheck = await client.query(
            'SELECT id, client_id FROM chat.chat_rooms WHERE id = $1',
            [roomId]
        );

        if (roomCheck.rows.length === 0) {
            throw new Error('Chat room not found');
        }

        // Видаляємо кімнату (cascade видалить повідомлення)
        await client.query('DELETE FROM chat.chat_rooms WHERE id = $1', [roomId]);

        return roomCheck.rows[0];
    }

    // Отримання чат-кімнат для співробітників з фільтрами
    static async getStaffRooms(filters, page = 1, limit = 20) {
        const offset = (page - 1) * limit;
        
        let whereClause = '';
        let queryParams = [];
        let paramCount = 0;

        // Побудова WHERE умов
        if (filters.status) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `cr.room_status = $${++paramCount}`;
            queryParams.push(filters.status);
        }

        if (filters.room_type) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `cr.room_type = $${++paramCount}`;
            queryParams.push(filters.room_type);
        }

        if (filters.assigned_to) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            if (filters.assigned_to === 'unassigned') {
                whereClause += `cr.assigned_staff_id IS NULL`;
            } else {
                whereClause += `cr.assigned_staff_id = $${++paramCount}`;
                queryParams.push(filters.assigned_to);
            }
        }

        if (filters.client_id) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `cr.client_id = $${++paramCount}`;
            queryParams.push(filters.client_id);
        }

        if (filters.search) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `(c.name ILIKE $${++paramCount} OR t.title ILIKE $${++paramCount} OR t.ticket_number ILIKE $${++paramCount})`;
            const searchTerm = `%${filters.search}%`;
            queryParams.push(searchTerm, searchTerm, searchTerm);
        }

        if (filters.created_from) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(cr.created_at) >= $${++paramCount}`;
            queryParams.push(filters.created_from);
        }

        if (filters.created_to) {
            whereClause += paramCount > 0 ? ' AND ' : ' WHERE ';
            whereClause += `DATE(cr.created_at) <= $${++paramCount}`;
            queryParams.push(filters.created_to);
        }

        // Сортування
        let orderBy = 'ORDER BY cr.last_message_at DESC NULLS LAST, cr.created_at DESC';
        if (filters.sortBy) {
            const allowedSortFields = ['created_at', 'last_message_at', 'client_name', 'room_status'];
            if (allowedSortFields.includes(filters.sortBy)) {
                const direction = filters.sortDesc === 'true' ? 'DESC' : 'ASC';
                if (filters.sortBy === 'client_name') {
                    orderBy = `ORDER BY c.name ${direction}`;
                } else {
                    orderBy = `ORDER BY cr.${filters.sortBy} ${direction}`;
                }
            }
        }

        // Додаємо limit та offset
        queryParams.push(limit, offset);

        const roomsQuery = `
            SELECT 
                cr.*,
                c.name as client_name,
                c.email as client_email,
                t.ticket_number,
                t.title as ticket_title,
                t.status as ticket_status,
                u.first_name || ' ' || u.last_name as assigned_staff_name,
                u.email as assigned_staff_email,
                COUNT(cm.id) as total_messages,
                COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'client') as unread_client_messages,
                (
                    SELECT json_build_object(
                        'id', last_msg.id,
                        'message_text', last_msg.message_text,
                        'created_at', last_msg.created_at,
                        'sender_type', last_msg.sender_type,
                        'sender_name',
                        CASE 
                            WHEN last_msg.sender_type = 'client' THEN lm_client.name
                            ELSE lm_user.first_name || ' ' || lm_user.last_name
                        END
                    )
                    FROM chat.chat_messages last_msg
                    LEFT JOIN clients.clients lm_client ON last_msg.sender_type = 'client' AND last_msg.sender_id = lm_client.id
                    LEFT JOIN auth.users lm_user ON last_msg.sender_type = 'staff' AND last_msg.sender_id = lm_user.id
                    WHERE last_msg.room_id = cr.id
                    ORDER BY last_msg.created_at DESC
                    LIMIT 1
                ) as last_message
            FROM chat.chat_rooms cr
            JOIN clients.clients c ON cr.client_id = c.id
            LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
            LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
            LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
            ${whereClause}
            GROUP BY cr.id, c.name, c.email, t.ticket_number, t.title, t.status, u.first_name, u.last_name, u.email
            ${orderBy}
            LIMIT $${++paramCount} OFFSET $${++paramCount}
        `;

        // Запит для підрахунку загальної кількості
        const countParams = queryParams.slice(0, -2);
        const countQuery = `
            SELECT COUNT(DISTINCT cr.id) as count
            FROM chat.chat_rooms cr
            JOIN clients.clients c ON cr.client_id = c.id
            LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
            LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
            ${whereClause}
        `;

        const [roomsResult, countResult] = await Promise.all([
            pool.query(roomsQuery, queryParams),
            pool.query(countQuery, countParams)
        ]);

        return {
            rooms: roomsResult.rows,
            pagination: {
                page,
                limit,
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(countResult.rows[0].count / limit)
            }
        };
    }

    // Отримання метрик чату для дашборду
    static async getChatMetrics() {
        const metricsResult = await pool.query(`
            SELECT 
                COUNT(CASE WHEN room_status = 'active' THEN 1 END) as active_chats,
                COUNT(CASE WHEN assigned_staff_id IS NULL AND room_status = 'active' THEN 1 END) as unassigned_chats,
                COUNT(CASE WHEN room_status = 'closed' AND DATE(closed_at) = CURRENT_DATE THEN 1 END) as closed_today,
                COUNT(CASE WHEN DATE(created_at) = CURRENT_DATE THEN 1 END) as created_today,
                (
                    SELECT COUNT(*)
                    FROM chat.chat_messages cm
                    JOIN chat.chat_rooms cr ON cm.room_id = cr.id
                    WHERE cm.is_read = false 
                    AND cm.sender_type = 'client'
                    AND cr.room_status = 'active'
                ) as unread_messages,
                (
                    SELECT AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 60)
                    FROM chat.chat_rooms
                    WHERE room_status = 'closed'
                    AND DATE(closed_at) >= CURRENT_DATE - INTERVAL '7 days'
                ) as avg_resolution_time_minutes
            FROM chat.chat_rooms
        `);

        const staffWorkloadResult = await pool.query(`
            SELECT 
                u.id,
                u.first_name || ' ' || u.last_name as staff_name,
                u.email,
                COUNT(cr.id) as active_chats,
                COUNT(CASE WHEN cr.created_at >= CURRENT_DATE THEN 1 END) as today_chats,
                (
                    SELECT COUNT(*)
                    FROM chat.chat_messages cm
                    JOIN chat.chat_rooms cr2 ON cm.room_id = cr2.id
                    WHERE cr2.assigned_staff_id = u.id
                    AND cm.sender_type = 'client'
                    AND cm.is_read = false
                ) as unread_messages
            FROM auth.users u
            LEFT JOIN chat.chat_rooms cr ON u.id = cr.assigned_staff_id AND cr.room_status = 'active'
            WHERE u.is_active = true
            AND EXISTS (
                SELECT 1 FROM auth.user_roles ur
                JOIN auth.role_permissions rp ON ur.role_id = rp.role_id
                JOIN auth.permissions p ON rp.permission_id = p.id
                WHERE ur.user_id = u.id AND p.code = 'chat.read'
            )
            GROUP BY u.id, u.first_name, u.last_name, u.email
            ORDER BY active_chats DESC
        `);

        return {
            metrics: metricsResult.rows[0],
            staff_workload: staffWorkloadResult.rows
        };
    }

    // Масове призначення чатів
    static async bulkAssignRooms(client, roomIds, assignedTo) {
        // Валідація співробітника
        if (assignedTo) {
            const staffCheck = await client.query(
                'SELECT id FROM auth.users WHERE id = $1 AND is_active = true',
                [assignedTo]
            );
            
            if (staffCheck.rows.length === 0) {
                throw new Error('Staff member not found');
            }
        }

        // Оновлення кімнат
        const placeholders = roomIds.map((_, index) => `$${index + 2}`).join(',');
        const result = await client.query(
            `UPDATE chat.chat_rooms 
             SET assigned_staff_id = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders})
             AND room_status = 'active'
             RETURNING *`,
            [assignedTo, ...roomIds]
        );

        return result.rows;
    }

    // Масове закриття чатів
    static async bulkCloseRooms(client, roomIds, staffId, closeReason) {
        // Перевіряємо чи існують кімнати та чи вони активні
        const checkRooms = await client.query(
            `SELECT id FROM chat.chat_rooms 
             WHERE id = ANY($1::uuid[]) AND room_status = 'active'`,
            [roomIds]
        );

        if (checkRooms.rows.length === 0) {
            throw new Error('No active rooms found with provided IDs');
        }

        // Закриваємо кімнати
        const result = await client.query(
            `UPDATE chat.chat_rooms 
             SET room_status = 'closed', 
                 closed_at = CURRENT_TIMESTAMP, 
                 closed_by = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ANY($2::uuid[])
             AND room_status = 'active'
             RETURNING *`,
            [staffId, roomIds]
        );

        // Додаємо системні повідомлення з причиною закриття
        for (const room of result.rows) {
            await client.query(
                `INSERT INTO chat.chat_messages (room_id, message_text, sender_id, sender_type)
                 VALUES ($1, $2, $3, 'staff')`,
                [
                    room.id, 
                    `Chat closed by staff. Reason: ${closeReason || 'Bulk operation'}`,
                    staffId
                ]
            );
        }

        return result.rows;
    }

    // Пошук в чатах та повідомленнях
    static async searchChats(query, searchType = 'all', limit = 20) {
        if (!query || query.trim().length < 2) {
            throw new Error('Search query must be at least 2 characters');
        }

        const searchTerm = `%${query.trim()}%`;
        let results = {
            rooms: [],
            messages: []
        };

        // Пошук в кімнатах/клієнтах
        if (searchType === 'all' || searchType === 'rooms') {
            const roomsResult = await pool.query(`
                SELECT 
                    cr.id,
                    cr.room_type,
                    cr.room_status,
                    cr.created_at,
                    c.name as client_name,
                    c.email as client_email,
                    t.ticket_number,
                    t.title as ticket_title,
                    u.first_name || ' ' || u.last_name as assigned_staff_name
                FROM chat.chat_rooms cr
                JOIN clients.clients c ON cr.client_id = c.id
                LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
                LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
                WHERE (
                    c.name ILIKE $1 OR 
                    c.email ILIKE $1 OR 
                    t.title ILIKE $1 OR 
                    t.ticket_number ILIKE $1
                )
                ORDER BY cr.created_at DESC
                LIMIT $2
            `, [searchTerm, limit]);

            results.rooms = roomsResult.rows;
        }

        // Пошук в повідомленнях
        if (searchType === 'all' || searchType === 'messages') {
            const messagesResult = await pool.query(`
                SELECT 
                    cm.id,
                    cm.room_id,
                    cm.message_text,
                    cm.sender_type,
                    cm.created_at,
                    c.name as client_name,
                    CASE 
                        WHEN cm.sender_type = 'client' THEN c.name
                        ELSE u.first_name || ' ' || u.last_name
                    END as sender_name,
                    cr.room_type
                FROM chat.chat_messages cm
                JOIN chat.chat_rooms cr ON cm.room_id = cr.id
                JOIN clients.clients c ON cr.client_id = c.id
                LEFT JOIN auth.users u ON (cm.sender_type = 'staff' AND cm.sender_id = u.id)
                WHERE cm.message_text ILIKE $1
                ORDER BY cm.created_at DESC
                LIMIT $2
            `, [searchTerm, limit]);

            results.messages = messagesResult.rows;
        }

        return {
            query: query.trim(),
            results
        };
    }

    // Отримання конкретної чат-кімнати для співробітників
    static async getStaffRoomById(roomId) {
        const result = await pool.query(`
            SELECT 
                cr.*,
                c.name as client_name,
                c.email as client_email,
                t.ticket_number,
                t.title as ticket_title,
                t.status as ticket_status,
                u.first_name || ' ' || u.last_name as assigned_staff_name,
                u.email as assigned_staff_email,
                COUNT(cm.id) as total_messages,
                COUNT(cm.id) FILTER (WHERE cm.is_read = false AND cm.sender_type = 'client') as unread_client_messages,
                (
                    SELECT json_build_object(
                        'id', last_msg.id,
                        'message_text', last_msg.message_text,
                        'created_at', last_msg.created_at,
                        'sender_type', last_msg.sender_type,
                        'sender_name',
                        CASE 
                            WHEN last_msg.sender_type = 'client' THEN lm_client.name
                            ELSE lm_user.first_name || ' ' || lm_user.last_name
                        END
                    )
                    FROM chat.chat_messages last_msg
                    LEFT JOIN clients.clients lm_client ON last_msg.sender_type = 'client' AND last_msg.sender_id = lm_client.id
                    LEFT JOIN auth.users lm_user ON last_msg.sender_type = 'staff' AND last_msg.sender_id = lm_user.id
                    WHERE last_msg.room_id = cr.id
                    ORDER BY last_msg.created_at DESC
                    LIMIT 1
                ) as last_message
            FROM chat.chat_rooms cr
            JOIN clients.clients c ON cr.client_id = c.id
            LEFT JOIN tickets.tickets t ON cr.ticket_id = t.id
            LEFT JOIN auth.users u ON cr.assigned_staff_id = u.id
            LEFT JOIN chat.chat_messages cm ON cr.id = cm.room_id
            WHERE cr.id = $1
            GROUP BY cr.id, c.name, c.email, t.ticket_number, t.title, t.status, u.first_name, u.last_name, u.email
        `, [roomId]);

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Отримання доступних співробітників для призначення
    static async getAvailableStaff() {
        const result = await pool.query(`
            SELECT 
                u.id,
                u.first_name || ' ' || u.last_name as name,
                u.email,
                COUNT(cr.id) as active_chats,
                u.is_active
            FROM auth.users u
            LEFT JOIN chat.chat_rooms cr ON u.id = cr.assigned_staff_id AND cr.room_status = 'active'
            WHERE u.is_active = true
            AND EXISTS (
                SELECT 1 FROM auth.user_roles ur
                JOIN auth.role_permissions rp ON ur.role_id = rp.role_id
                JOIN auth.permissions p ON rp.permission_id = p.id
                WHERE ur.user_id = u.id AND p.code = 'chat.read'
            )
            GROUP BY u.id, u.first_name, u.last_name, u.email, u.is_active
            ORDER BY active_chats ASC, u.first_name ASC
        `);

        return result.rows;
    }
}

module.exports = ChatService;