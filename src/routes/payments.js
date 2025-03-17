const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const PaymentService = require('../services/paymentService');

// Отримання списку платежів
router.get('/', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const result = await PaymentService.getPayments(req.query);
        res.json({
            success: true,
            payments: result.payments,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку платежів'
        });
    }
});

// Отримання статистики платежів
router.get('/statistics', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const result = await PaymentService.getPaymentsStatistics(req.query);
        res.json({
            success: true,
            statistics: result
        });
    } catch (error) {
        console.error('Error fetching payment statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні статистики платежів'
        });
    }
});

// Експорт платежів в Excel
router.get('/export', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const buffer = await PaymentService.exportPayments(req.query);
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=payments.xlsx');
        res.send(buffer);
    } catch (error) {
        console.error('Error exporting payments:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при експорті платежів'
        });
    }
});

// Отримання платежів за клієнтом
router.get('/client/:clientId', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const result = await PaymentService.getClientPayments(req.params.clientId, req.query);
        res.json({
            success: true,
            payments: result.payments,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching client payments:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні платежів клієнта'
        });
    }
});

// Отримання історії платежів за об'єктом
router.get('/object/:objectId', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const result = await PaymentService.getObjectPaymentHistory(req.params.objectId, req.query);
        res.json({
            success: true,
            payments: result.payments,
            total: result.total,
            object: result.object
        });
    } catch (error) {
        console.error('Error fetching object payment history:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні історії платежів за об\'єктом'
        });
    }
});

// Отримання деталей платежу
router.get('/:id', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const payment = await PaymentService.getPaymentDetails(req.params.id);
        
        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'Платіж не знайдено'
            });
        }
        
        res.json({
            success: true,
            payment
        });
    } catch (error) {
        console.error('Error fetching payment details:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні деталей платежу'
        });
    }
});

// Створення нового платежу
router.post('/', authenticate, checkPermission('payments.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const payment = await PaymentService.createPayment(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            payment
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating payment:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні платежу'
        });
    } finally {
        client.release();
    }
});

// Редагування платежу
router.put('/:id', authenticate, checkPermission('payments.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const updatedPayment = await PaymentService.updatePayment(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            payment: updatedPayment
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating payment:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні платежу'
        });
    } finally {
        client.release();
    }
});

// Видалення платежу
router.delete('/:id', authenticate, checkPermission('payments.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await PaymentService.deletePayment(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Платіж успішно видалено'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting payment:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні платежу'
        });
    } finally {
        client.release();
    }
});

module.exports = router;