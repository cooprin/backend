const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const InvoiceTemplatesService = require('../services/invoice-templates.service');

// Отримання списку шаблонів
router.get('/', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const result = await InvoiceTemplatesService.getTemplates(req.query);
        
        res.json({
            success: true,
            templates: result.templates,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching invoice templates:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку шаблонів рахунків'
        });
    }
});

// Отримання шаблону за ID
router.get('/:id', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const template = await InvoiceTemplatesService.getTemplateById(req.params.id);
        
        if (!template) {
            return res.status(404).json({
                success: false,
                message: 'Шаблон не знайдено'
            });
        }
        
        res.json({
            success: true,
            template
        });
    } catch (error) {
        console.error('Error fetching invoice template:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні шаблону рахунку'
        });
    }
});

// Створення шаблону
router.post('/', authenticate, checkPermission('invoices.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const template = await InvoiceTemplatesService.createTemplate(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            template
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating invoice template:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні шаблону рахунку'
        });
    } finally {
        client.release();
    }
});

// Оновлення шаблону
router.put('/:id', authenticate, checkPermission('invoices.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const template = await InvoiceTemplatesService.updateTemplate(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            template
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating invoice template:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні шаблону рахунку'
        });
    } finally {
        client.release();
    }
});

// Видалення шаблону
router.delete('/:id', authenticate, checkPermission('invoices.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await InvoiceTemplatesService.deleteTemplate(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Шаблон успішно видалено'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting invoice template:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні шаблону рахунку'
        });
    } finally {
        client.release();
    }
});

// Отримання шаблону за замовчуванням
router.get('/default/template', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const template = await InvoiceTemplatesService.getDefaultTemplate();
        
        if (!template) {
            return res.status(404).json({
                success: false,
                message: 'Шаблон за замовчуванням не знайдено'
            });
        }
        
        res.json({
            success: true,
            template
        });
    } catch (error) {
        console.error('Error fetching default invoice template:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні шаблону за замовчуванням'
        });
    }
});

module.exports = router;