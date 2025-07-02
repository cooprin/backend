const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { staffOnly } = require('../middleware/clientAccess');
const ReportsService = require('../services/reports.service');

// Отримання звітів для конкретної сторінки (доступно всім авторизованим користувачам)
router.get('/page/:pageIdentifier', authenticate, async (req, res) => {
    try {
        const { pageIdentifier } = req.params;
        const { userType, userId, clientId } = req.user;

        const reports = await ReportsService.getPageReports(
            pageIdentifier,
            userId,
            userType,
            userType === 'client' ? clientId : null
        );

        res.json({
            success: true,
            reports
        });
    } catch (error) {
        console.error('Error fetching page reports:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні звітів для сторінки'
        });
    }
});

// Виконання звіту (доступно всім авторизованим користувачам)
router.post('/:id/execute', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { parameters = {}, pageIdentifier } = req.body;
        const { userType, userId, clientId } = req.user;

        const result = await ReportsService.executeReport(
            id,
            parameters,
            userId,
            userType,
            userType === 'client' ? clientId : null,
            pageIdentifier,
            req
        );

        if (result.success) {
            res.json({
                success: true,
                executionId: result.execution_id,
                data: result.data,
                executionTime: result.execution_time,
                rowsCount: result.rows_count,
                fromCache: result.from_cache
            });
        } else {
            res.status(400).json({
                success: false,
                message: result.error_message || 'Помилка при виконанні звіту'
            });
        }
    } catch (error) {
        console.error('Error executing report:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при виконанні звіту'
        });
    }
});

// === АДМІНІСТРАТИВНІ МАРШРУТИ (тільки для персоналу) ===

// Отримання списку звітів (тільки персонал)
router.get('/', authenticate, staffOnly, checkPermission('reports.read'), async (req, res) => {
    try {
        const result = await ReportsService.getReports(req.query);
        res.json({
            success: true,
            reports: result.reports,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching reports:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку звітів'
        });
    }
});

// Отримання одного звіту за ID (тільки персонал)
router.get('/:id', authenticate, staffOnly, checkPermission('reports.read'), async (req, res) => {
    try {
        const report = await ReportsService.getReportById(req.params.id);
        
        if (!report) {
            return res.status(404).json({
                success: false,
                message: 'Звіт не знайдений'
            });
        }
        
        res.json({
            success: true,
            report
        });
    } catch (error) {
        console.error('Error fetching report:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні даних звіту'
        });
    }
});

// Створення звіту (тільки персонал)
router.post('/', authenticate, staffOnly, checkPermission('reports.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Валідація обов'язкових полів
        const { name, code, sql_query } = req.body;
        if (!name || name.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Назва звіту є обов\'язковою'
            });
        }

        if (!code || code.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Код звіту є обов\'язковим'
            });
        }

        if (!sql_query || sql_query.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'SQL запит є обов\'язковим'
            });
        }

        // Валідація формату виводу
        const validFormats = ['table', 'chart', 'export', 'both'];
        if (req.body.output_format && !validFormats.includes(req.body.output_format)) {
            return res.status(400).json({
                success: false,
                message: 'Невірний формат виводу звіту'
            });
        }

        // Валідація параметрів звіту
        if (req.body.parameters && Array.isArray(req.body.parameters)) {
            const validParameterTypes = ['text', 'number', 'date', 'datetime', 'select', 'multiselect', 'boolean', 'client_id', 'user_id'];
            for (const param of req.body.parameters) {
                if (!param.parameter_name || !param.parameter_type) {
                    return res.status(400).json({
                        success: false,
                        message: 'Усі параметри повинні мати назву та тип'
                    });
                }
                if (!validParameterTypes.includes(param.parameter_type)) {
                    return res.status(400).json({
                        success: false,
                        message: `Невірний тип параметра: ${param.parameter_type}`
                    });
                }
            }
        }
        
        const newReport = await ReportsService.createReport(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            report: newReport
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating report:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні звіту'
        });
    } finally {
        client.release();
    }
});

// Оновлення звіту (тільки персонал)
router.put('/:id', authenticate, staffOnly, checkPermission('reports.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Валідація обов'язкових полів при оновленні
        if (req.body.name !== undefined && (!req.body.name || req.body.name.trim() === '')) {
            return res.status(400).json({
                success: false,
                message: 'Назва звіту є обов\'язковою'
            });
        }

        if (req.body.code !== undefined && (!req.body.code || req.body.code.trim() === '')) {
            return res.status(400).json({
                success: false,
                message: 'Код звіту є обов\'язковим'
            });
        }

        if (req.body.sql_query !== undefined && (!req.body.sql_query || req.body.sql_query.trim() === '')) {
            return res.status(400).json({
                success: false,
                message: 'SQL запит є обов\'язковим'
            });
        }

        // Валідація формату виводу
        const validFormats = ['table', 'chart', 'export', 'both'];
        if (req.body.output_format && !validFormats.includes(req.body.output_format)) {
            return res.status(400).json({
                success: false,
                message: 'Невірний формат виводу звіту'
            });
        }

        // Валідація параметрів звіту
        if (req.body.parameters && Array.isArray(req.body.parameters)) {
            const validParameterTypes = ['text', 'number', 'date', 'datetime', 'select', 'multiselect', 'boolean', 'client_id', 'user_id'];
            for (const param of req.body.parameters) {
                if (!param.parameter_name || !param.parameter_type) {
                    return res.status(400).json({
                        success: false,
                        message: 'Усі параметри повинні мати назву та тип'
                    });
                }
                if (!validParameterTypes.includes(param.parameter_type)) {
                    return res.status(400).json({
                        success: false,
                        message: `Невірний тип параметра: ${param.parameter_type}`
                    });
                }
            }
        }
        
        const updatedReport = await ReportsService.updateReport(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            report: updatedReport
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating report:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні звіту'
        });
    } finally {
        client.release();
    }
});

// Видалення звіту (тільки персонал)
router.delete('/:id', authenticate, staffOnly, checkPermission('reports.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await ReportsService.deleteReport(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Звіт успішно видалений'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting report:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні звіту'
        });
    } finally {
        client.release();
    }
});

// Отримання історії виконання звіту (тільки персонал)
router.get('/:id/history', authenticate, staffOnly, checkPermission('reports.read'), async (req, res) => {
    try {
        const result = await ReportsService.getExecutionHistory(req.params.id, req.query);
        
        res.json({
            success: true,
            history: result.history,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching execution history:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні історії виконання звіту'
        });
    }
});

// Очищення застарілого кешу (тільки персонал)
router.post('/cache/clear', authenticate, staffOnly, checkPermission('reports.update'), async (req, res) => {
    try {
        const clearedCount = await ReportsService.clearExpiredCache();
        
        res.json({
            success: true,
            message: `Видалено ${clearedCount} застарілих записів кешу`
        });
    } catch (error) {
        console.error('Error clearing cache:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при очищенні кешу'
        });
    }
});

// Завантаження звітів з файлів (тільки персонал)
router.post('/load-from-files', authenticate, staffOnly, checkPermission('reports.create'), upload.array('reports', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Не завантажено жодного файлу'
            });
        }

        const result = await ReportsService.loadReportsFromFiles(req.files, req.user.userId, req);
        
        res.json({
            success: true,
            result
        });
    } catch (error) {
        console.error('Error loading reports from files:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Помилка при завантаженні звітів з файлів'
        });
    }
});

// Попередній перегляд SQL запиту (тільки персонал)
router.post('/preview-sql', authenticate, staffOnly, checkPermission('reports.read'), async (req, res) => {
    try {
        const { sql_query, parameters = {}, limit = 10 } = req.body;
        
        if (!sql_query || sql_query.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'SQL запит є обов\'язковим'
            });
        }

        // Підготовляємо SQL запит з параметрами
        let previewQuery = sql_query;
        
        // Замінюємо параметри в запиті (як в execute_report функції)
        for (const [paramKey, paramValue] of Object.entries(parameters)) {
            previewQuery = previewQuery.replace(
                new RegExp(':' + paramKey, 'g'), 
                `'${paramValue}'`
            );
        }
        
        // Додаємо LIMIT для безпеки
        const limitedQuery = `SELECT * FROM (${previewQuery}) preview_data LIMIT ${parseInt(limit)}`;
        
        const result = await pool.query(limitedQuery);
        
        res.json({
            success: true,
            data: result.rows,
            rowsCount: result.rows.length,
            query: limitedQuery
        });
        
    } catch (error) {
        console.error('Error previewing SQL query:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при виконанні SQL запиту'
        });
    }
});

module.exports = router;