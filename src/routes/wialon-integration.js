const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const WialonIntegrationService = require('../services/wialon-integration.service');

// Отримання налаштувань інтеграції
router.get('/', authenticate, checkPermission('wialon_integration.read'), async (req, res) => {
    try {
        const settings = await WialonIntegrationService.getIntegrationSettings();
        
        res.json({
            success: true,
            settings
        });
    } catch (error) {
        console.error('Error fetching wialon integration settings:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні налаштувань інтеграції Wialon'
        });
    }
});

// Збереження налаштувань інтеграції
router.post('/', authenticate, checkPermission('wialon_integration.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const result = await WialonIntegrationService.saveIntegrationSettings(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving wialon integration settings:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при збереженні налаштувань інтеграції Wialon'
        });
    } finally {
        client.release();
    }
});

// Тестування підключення до Wialon
router.post('/test-connection', authenticate, checkPermission('wialon_integration.read'), async (req, res) => {
    try {
        const result = await WialonIntegrationService.testConnection();
        
        res.json(result);
    } catch (error) {
        console.error('Error testing wialon connection:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Помилка при тестуванні підключення до Wialon'
        });
    }
});

// ВИДАЛЕНО: /sync ендпоінт
// Тепер синхронізація відбувається через /wialon-sync/start

module.exports = router;