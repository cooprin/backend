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

// Отримання оплачених періодів для об'єкта
router.get('/periods/:objectId', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const periods = await PaymentService.getObjectPaidPeriods(req.params.objectId);
        
        res.json({
            success: true,
            periods
        });
    } catch (error) {
        console.error('Error fetching object paid periods:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні оплачених періодів'
        });
    }
});

// Перевірка чи період оплачений для об'єкта
router.get('/is-period-paid/:objectId', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const { year, month } = req.query;
        
        if (!year || !month) {
            return res.status(400).json({
                success: false,
                message: 'Необхідно вказати рік та місяць'
            });
        }
        
        const isPaid = await PaymentService.isPeriodPaid(req.params.objectId, year, month);
        
        res.json({
            success: true,
            isPaid
        });
    } catch (error) {
        console.error('Error checking if period is paid:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при перевірці оплати періоду'
        });
    }
});

// Отримання наступного неоплаченого періоду для об'єкта
router.get('/next-unpaid-period/:objectId', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const period = await PaymentService.getNextUnpaidPeriod(req.params.objectId);
        
        res.json({
            success: true,
            period
        });
    } catch (error) {
        console.error('Error fetching next unpaid period:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні наступного неоплаченого періоду'
        });
    }
});

// Отримання об'єктів клієнта з інформацією про оплати
router.get('/client-objects/:clientId', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const { year, month } = req.query;
        const objects = await PaymentService.getClientObjectsWithPayments(
            req.params.clientId,
            year,
            month
        );
        
        res.json({
            success: true,
            objects
        });
    } catch (error) {
        console.error('Error fetching client objects with payments:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні об\'єктів клієнта з інформацією про оплати'
        });
    }
});

// Отримання доступних періодів для оплати для об'єкта
router.get('/available-periods/:objectId', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const count = req.query.count ? parseInt(req.query.count) : 12;
        const periods = await PaymentService.getAvailablePaymentPeriods(req.params.objectId, count);
        
        res.json({
            success: true,
            periods
        });
    } catch (error) {
        console.error('Error fetching available payment periods:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні доступних періодів для оплати'
        });
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

// Отримання метрик прострочених платежів
router.get('/overdue/metrics', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const metrics = await PaymentService.getOverdueMetrics();
        res.json({
            success: true,
            metrics
        });
    } catch (error) {
        console.error('Error fetching overdue metrics:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні метрик прострочених платежів'
        });
    }
});

// Отримання клієнтів з простроченими платежами
router.get('/overdue/clients', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const clients = await PaymentService.getOverdueClients();
        res.json({
            success: true,
            clients
        });
    } catch (error) {
        console.error('Error fetching overdue clients:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні клієнтів з простроченими платежами'
        });
    }
});

// Отримання об'єктів з простроченими платежами
router.get('/overdue/objects', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const objects = await PaymentService.getOverdueObjects();
        res.json({
            success: true,
            objects
        });
    } catch (error) {
        console.error('Error fetching overdue objects:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні об\'єктів з простроченими платежами'
        });
    }
});

// Отримання щомісячних даних про прострочені платежі
router.get('/overdue/monthly', authenticate, checkPermission('payments.read'), async (req, res) => {
    try {
        const monthlyData = await PaymentService.getOverdueByMonth();
        res.json({
            success: true,
            monthlyData
        });
    } catch (error) {
        console.error('Error fetching monthly overdue data:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні щомісячних даних про прострочені платежі'
        });
    }
});

module.exports = router;