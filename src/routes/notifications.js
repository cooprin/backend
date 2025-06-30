const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const NotificationService = require('../services/notificationService');

// Отримання сповіщень для поточного користувача
router.get('/', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        
        let recipientId, recipientType;
        if (req.user.userType === 'client') {
            recipientId = req.user.clientId;
            recipientType = 'client';
        } else {
            recipientId = req.user.userId;
            recipientType = 'staff';
        }

        const result = await NotificationService.getUserNotifications(
            recipientId, 
            recipientType, 
            page, 
            limit
        );

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Отримання кількості непрочитаних сповіщень
router.get('/unread-count', authenticate, async (req, res) => {
    try {
        let recipientId, recipientType;
        if (req.user.userType === 'client') {
            recipientId = req.user.clientId;
            recipientType = 'client';
        } else {
            recipientId = req.user.userId;
            recipientType = 'staff';
        }

        const counts = await NotificationService.getUnreadCount(recipientId, recipientType);

        res.json({
            success: true,
            counts
        });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Позначити сповіщення як прочитане
router.patch('/:id/read', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        
        let recipientId, recipientType;
        if (req.user.userType === 'client') {
            recipientId = req.user.clientId;
            recipientType = 'client';
        } else {
            recipientId = req.user.userId;
            recipientType = 'staff';
        }

        const notification = await NotificationService.markAsRead(id, recipientId, recipientType);

        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        // Real-time оновлення лічильника сповіщень
        if (global.socketIO) {
            global.socketIO.emitToUser(recipientId, 'notification_read', {
                notification_id: id,
                unread_count_change: -1
            });
        }

        res.json({
            success: true,
            notification
        });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Позначити всі сповіщення як прочитані
router.patch('/read-all', authenticate, async (req, res) => {
    try {
        let recipientId, recipientType;
        if (req.user.userType === 'client') {
            recipientId = req.user.clientId;
            recipientType = 'client';
        } else {
            recipientId = req.user.userId;
            recipientType = 'staff';
        }

        const markedCount = await NotificationService.markAllAsRead(recipientId, recipientType);

        // Real-time оновлення лічильника сповіщень
        if (global.socketIO && markedCount > 0) {
            global.socketIO.emitToUser(recipientId, 'notifications_all_read', {
                marked_count: markedCount
            });
        }

        res.json({
            success: true,
            marked_count: markedCount
        });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Отримання статистики сповіщень
router.get('/stats', authenticate, async (req, res) => {
    try {
        let recipientId, recipientType;
        if (req.user.userType === 'client') {
            recipientId = req.user.clientId;
            recipientType = 'client';
        } else {
            recipientId = req.user.userId;
            recipientType = 'staff';
        }

        const stats = await NotificationService.getNotificationStats(recipientId, recipientType);

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error fetching notification stats:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Масове видалення сповіщень
router.delete('/bulk', authenticate, async (req, res) => {
    try {
        const { notification_ids } = req.body;

        if (!notification_ids || !Array.isArray(notification_ids) || notification_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'notification_ids array is required'
            });
        }

        let recipientId, recipientType;
        if (req.user.userType === 'client') {
            recipientId = req.user.clientId;
            recipientType = 'client';
        } else {
            recipientId = req.user.userId;
            recipientType = 'staff';
        }

        const deletedCount = await NotificationService.bulkDelete(
            notification_ids, 
            recipientId, 
            recipientType
        );

        res.json({
            success: true,
            deleted_count: deletedCount
        });
    } catch (error) {
        console.error('Error bulk deleting notifications:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Масове позначення як прочитані
router.patch('/bulk-read', authenticate, async (req, res) => {
    try {
        const { notification_ids } = req.body;

        if (!notification_ids || !Array.isArray(notification_ids) || notification_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'notification_ids array is required'
            });
        }

        let recipientId, recipientType;
        if (req.user.userType === 'client') {
            recipientId = req.user.clientId;
            recipientType = 'client';
        } else {
            recipientId = req.user.userId;
            recipientType = 'staff';
        }

        const markedCount = await NotificationService.bulkMarkAsRead(
            notification_ids, 
            recipientId, 
            recipientType
        );

        // Real-time оновлення
        if (global.socketIO && markedCount > 0) {
            global.socketIO.emitToUser(recipientId, 'notifications_bulk_read', {
                marked_count: markedCount,
                notification_ids: notification_ids
            });
        }

        res.json({
            success: true,
            marked_count: markedCount
        });
    } catch (error) {
        console.error('Error bulk marking notifications as read:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Очищення старих прочитаних сповіщень (тільки для адміністраторів)
router.post('/cleanup', authenticate, async (req, res) => {
    try {
        // Перевірка прав доступу (тільки адміністратори)
        if (req.user.userType !== 'staff') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { days_old = 30 } = req.body;
        const deletedCount = await NotificationService.cleanupOldNotifications(days_old);

        res.json({
            success: true,
            deleted_count: deletedCount,
            message: `Cleaned up ${deletedCount} old notifications older than ${days_old} days`
        });
    } catch (error) {
        console.error('Error cleaning up old notifications:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;