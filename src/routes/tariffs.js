const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const TariffService = require('../services/tariffs.service');

// Отримання списку тарифів
router.get('/', authenticate, checkPermission('tariffs.read'), async (req, res) => {
    try {
        const result = await TariffService.getTariffs(req.query);
        res.json({
            success: true,
            tariffs: result.tariffs,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching tariffs:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку тарифів'
        });
    }
});

// Отримання одного тарифу
router.get('/:id', authenticate, checkPermission('tariffs.read'), async (req, res) => {
    try {
        const tariff = await TariffService.getTariffById(req.params.id);
        
        if (!tariff) {
            return res.status(404).json({
                success: false,
                message: 'Тариф не знайдений'
            });
        }
        
        res.json({
            success: true,
            tariff
        });
    } catch (error) {
        console.error('Error fetching tariff:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні даних тарифу'
        });
    }
});

// Створення тарифу
router.post('/', authenticate, checkPermission('tariffs.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const newTariff = await TariffService.createTariff(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            tariff: newTariff
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating tariff:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні тарифу'
        });
    } finally {
        client.release();
    }
});

// Оновлення тарифу
router.put('/:id', authenticate, checkPermission('tariffs.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const updatedTariff = await TariffService.updateTariff(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            tariff: updatedTariff
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating tariff:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні тарифу'
        });
    } finally {
        client.release();
    }
});

// Видалення тарифу
router.delete('/:id', authenticate, checkPermission('tariffs.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await TariffService.deleteTariff(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Тариф успішно видалений'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting tariff:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні тарифу'
        });
    } finally {
        client.release();
    }
});

// Призначення тарифу об'єкту
router.post('/assign', authenticate, checkPermission('tariffs.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const assignment = await TariffService.assignTariffToObject(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            assignment
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error assigning tariff:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при призначенні тарифу'
        });
    } finally {
        client.release();
    }
});

// Отримання оптимальної дати зміни тарифу
router.get('/optimal-change-date/:objectId', authenticate, checkPermission('tariffs.read'), async (req, res) => {
    try {
        const changeDate = await TariffService.getOptimalTariffChangeDate(req.params.objectId);
        
        res.json({
            success: true,
            changeDate
        });
    } catch (error) {
        console.error('Error fetching optimal tariff change date:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні оптимальної дати зміни тарифу'
        });
    }
});

// Отримання запланованих змін тарифів
router.get('/planned-changes', authenticate, checkPermission('tariffs.read'), async (req, res) => {
    try {
        const result = await TariffService.getPlannedTariffChanges(req.query);
        
        res.json({
            success: true,
            planned_changes: result.planned_changes,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching planned tariff changes:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні запланованих змін тарифів'
        });
    }
});

// Скасування запланованої зміни тарифу
router.post('/cancel-planned-change/:objectId', authenticate, checkPermission('tariffs.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const result = await TariffService.cancelPlannedTariffChange(
            client,
            req.params.objectId,
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            result
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error cancelling planned tariff change:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при скасуванні запланованої зміни тарифу'
        });
    } finally {
        client.release();
    }
});

// Отримання історії тарифів для об'єкта
router.get('/history/:objectId', authenticate, checkPermission('tariffs.read'), async (req, res) => {
    try {
        const history = await TariffService.getObjectTariffHistory(req.params.objectId);
        
        res.json({
            success: true,
            history
        });
    } catch (error) {
        console.error('Error fetching tariff history:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні історії тарифів'
        });
    }
});

module.exports = router;