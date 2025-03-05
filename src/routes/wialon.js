const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const WialonService = require('../services/wialon.service');

// Отримання списку об'єктів
router.get('/', authenticate, checkPermission('wialon_objects.read'), async (req, res) => {
    try {
        const result = await WialonService.getObjects(req.query);
        res.json({
            success: true,
            objects: result.objects,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching objects:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку об\'єктів'
        });
    }
});

// Отримання одного об'єкта
router.get('/:id', authenticate, checkPermission('wialon_objects.read'), async (req, res) => {
    try {
        const object = await WialonService.getObjectById(req.params.id);
        
        if (!object) {
            return res.status(404).json({
                success: false,
                message: 'Об\'єкт не знайдений'
            });
        }
        
        res.json({
            success: true,
            object
        });
    } catch (error) {
        console.error('Error fetching object:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні даних об\'єкта'
        });
    }
});

// Створення об'єкта
router.post('/', authenticate, checkPermission('wialon_objects.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const newObject = await WialonService.createObject(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            object: newObject
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating object:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні об\'єкта'
        });
    } finally {
        client.release();
    }
});

// Оновлення об'єкта
router.put('/:id', authenticate, checkPermission('wialon_objects.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const updatedObject = await WialonService.updateObject(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            object: updatedObject
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating object:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні об\'єкта'
        });
    } finally {
        client.release();
    }
});

// Зміна власника об'єкта
router.post('/:id/change-owner', authenticate, checkPermission('wialon_objects.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const { client_id, notes } = req.body;
        
        if (!client_id) {
            throw new Error('ID клієнта обов\'язковий');
        }
        
        const updatedObject = await WialonService.changeOwner(
            client, 
            req.params.id, 
            client_id,
            notes,
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            object: updatedObject
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error changing object owner:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при зміні власника об\'єкта'
        });
    } finally {
        client.release();
    }
});

// Видалення об'єкта
router.delete('/:id', authenticate, checkPermission('wialon_objects.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await WialonService.deleteObject(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Об\'єкт успішно видалений'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting object:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні об\'єкта'
        });
    } finally {
        client.release();
    }
});

module.exports = router;