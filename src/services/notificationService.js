const { pool } = require('../database');

class NotificationService {
// Отримання сповіщень для користувача з фільтрами та пагінацією
static async getUserNotifications(recipientId, recipientType, filters = {}) {
    const { 
        page = 1, 
        limit = 20, 
        type, 
        status, 
        priority, 
        search,
        read_status 
    } = filters;

    const offset = (page - 1) * limit;

    // Побудова WHERE умов
    let whereConditions = ['recipient_id = $1', 'recipient_type = $2'];
    let params = [recipientId, recipientType];
    let paramIndex = 3;

    // Фільтр по типу сповіщення
    if (type) {
        whereConditions.push(`type = $${paramIndex}`);
        params.push(type);
        paramIndex++;
    }

    // Фільтр по статусу прочитання
    if (status === 'unread' || read_status === 'unread') {
        whereConditions.push(`is_read = false`);
    } else if (status === 'read' || read_status === 'read') {
        whereConditions.push(`is_read = true`);
    }

    // Фільтр по пріоритету
    if (priority) {
        whereConditions.push(`priority = $${paramIndex}`);
        params.push(priority);
        paramIndex++;
    }

    // Фільтр по пошуку в заголовку та повідомленні
    if (search && search.trim()) {
        whereConditions.push(`(title ILIKE $${paramIndex} OR message ILIKE $${paramIndex})`);
        params.push(`%${search.trim()}%`);
        paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Запити з урахуванням фільтрів
    const notificationsQuery = `
        SELECT * FROM notifications.view_notifications_with_details
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const countQuery = `
        SELECT COUNT(*) FROM notifications.notifications
        WHERE ${whereClause}
    `;

    // Додаємо limit та offset до параметрів
    const queryParams = [...params, limit, offset];
    const countParams = params; // Без limit та offset

    const [notificationsResult, countResult] = await Promise.all([
        pool.query(notificationsQuery, queryParams),
        pool.query(countQuery, countParams)
    ]);

    return {
        notifications: notificationsResult.rows,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: parseInt(countResult.rows[0].count),
            totalPages: Math.ceil(countResult.rows[0].count / limit)
        },
        filters: {
            type,
            status: status || read_status,
            priority,
            search
        }
    };
}

    // Отримання кількості непрочитаних сповіщень
    static async getUnreadCount(recipientId, recipientType) {
        const result = await pool.query(
            `SELECT * FROM notifications.view_unread_notifications
             WHERE recipient_id = $1 AND recipient_type = $2`,
            [recipientId, recipientType]
        );

        return result.rows[0] || {
            unread_count: 0,
            new_tickets_count: 0,
            ticket_comments_count: 0,
            chat_messages_count: 0,
            assigned_tickets_count: 0,
            assigned_chats_count: 0
        };
    }

    // Позначити сповіщення як прочитане
    static async markAsRead(notificationId, recipientId, recipientType) {
        const result = await pool.query(
            `UPDATE notifications.notifications 
             SET is_read = true, read_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND recipient_id = $2 AND recipient_type = $3
             RETURNING *`,
            [notificationId, recipientId, recipientType]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    }

    // Позначити всі сповіщення як прочитані
    static async markAllAsRead(recipientId, recipientType) {
        const result = await pool.query(
            `UPDATE notifications.notifications 
             SET is_read = true, read_at = CURRENT_TIMESTAMP
             WHERE recipient_id = $1 AND recipient_type = $2 AND is_read = false
             RETURNING id`,
            [recipientId, recipientType]
        );

        return result.rows.length;
    }

    // Створення нового сповіщення
    static async createNotification(data) {
        const {
            recipient_id,
            recipient_type,
            type,
            title,
            message,
            entity_type = null,
            entity_id = null,
            metadata = null,
            priority = 'normal'
        } = data;

        const result = await pool.query(
            `INSERT INTO notifications.notifications 
             (recipient_id, recipient_type, type, title, message, entity_type, entity_id, metadata, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [recipient_id, recipient_type, type, title, message, entity_type, entity_id, 
             metadata ? JSON.stringify(metadata) : null, priority]
        );

        return result.rows[0];
    }

    // Видалення старих прочитаних сповіщень
    static async cleanupOldNotifications(daysOld = 30) {
        const result = await pool.query(
            `DELETE FROM notifications.notifications 
             WHERE is_read = true 
             AND read_at < CURRENT_TIMESTAMP - INTERVAL '${daysOld} days'
             RETURNING id`,
        );

        return result.rows.length;
    }

    // Отримання статистики сповіщень
    static async getNotificationStats(recipientId, recipientType) {
        const result = await pool.query(
            `SELECT 
                COUNT(*) as total_count,
                COUNT(CASE WHEN is_read = false THEN 1 END) as unread_count,
                COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as today_count,
                COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as week_count
             FROM notifications.notifications
             WHERE recipient_id = $1 AND recipient_type = $2`,
            [recipientId, recipientType]
        );

        return result.rows[0];
    }

    // Масове видалення сповіщень
    static async bulkDelete(notificationIds, recipientId, recipientType) {
        const placeholders = notificationIds.map((_, index) => `$${index + 3}`).join(',');
        
        const result = await pool.query(
            `DELETE FROM notifications.notifications 
             WHERE id IN (${placeholders}) 
             AND recipient_id = $1 AND recipient_type = $2
             RETURNING id`,
            [recipientId, recipientType, ...notificationIds]
        );

        return result.rows.length;
    }

    // Масове позначення як прочитані
    static async bulkMarkAsRead(notificationIds, recipientId, recipientType) {
        const placeholders = notificationIds.map((_, index) => `$${index + 3}`).join(',');
        
        const result = await pool.query(
            `UPDATE notifications.notifications 
             SET is_read = true, read_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders}) 
             AND recipient_id = $1 AND recipient_type = $2 AND is_read = false
             RETURNING id`,
            [recipientId, recipientType, ...notificationIds]
        );

        return result.rows.length;
    }
}

module.exports = NotificationService;