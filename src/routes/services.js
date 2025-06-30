const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const ServiceService = require('../services/services.service');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFService = require('../services/pdfService');
const AuditService = require('../services/auditService');
const { AUDIT_TYPES } = require('../constants/constants');

// Налаштування для завантаження файлів
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.env.UPLOAD_DIR, 'invoice_documents');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'invoice-doc-' + uniqueSuffix + ext);
    }
});

const upload = multer({ storage });

// Отримання списку документів рахунку (додатковий корисний ендпойнт)
router.get('/invoices/:id/documents', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const documentsResult = await pool.query(
            `SELECT 
                id.id,
                id.document_name,
                id.document_type,
                id.file_path,
                id.file_size,
                id.created_at,
                u.email as uploaded_by_email,
                COALESCE(u.first_name || ' ' || u.last_name, u.email) as uploaded_by_name
            FROM services.invoice_documents id
            LEFT JOIN auth.users u ON id.uploaded_by = u.id
            WHERE id.invoice_id = $1
            ORDER BY id.created_at DESC`,
            [req.params.id]
        );

        res.json({
            success: true,
            documents: documentsResult.rows
        });
    } catch (error) {
        console.error('Error fetching invoice documents:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку документів'
        });
    }
});

// Завантаження документу (скачування)
router.get('/invoices/:id/documents/:documentId/download', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        // Отримуємо інформацію про документ
        const documentResult = await pool.query(
            'SELECT * FROM services.invoice_documents WHERE id = $1 AND invoice_id = $2',
            [req.params.documentId, req.params.id]
        );

        if (documentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Документ не знайдено'
            });
        }

        const document = documentResult.rows[0];
        const fullFilePath = path.join(process.env.UPLOAD_DIR, document.file_path);

        // Перевіряємо чи існує файл
        if (!fs.existsSync(fullFilePath)) {
            return res.status(404).json({
                success: false,
                message: 'Файл не знайдено на сервері'
            });
        }

        // Встановлюємо заголовки для скачування
        res.setHeader('Content-Disposition', `attachment; filename="${document.document_name}"`);
        res.setHeader('Content-Type', 'application/octet-stream');

        // Відправляємо файл
        res.sendFile(fullFilePath);
    } catch (error) {
        console.error('Error downloading document:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при завантаженні документа'
        });
    }
});

// Отримання списку послуг
router.get('/', authenticate, checkPermission('services.read'), async (req, res) => {
    try {
        const result = await ServiceService.ge
        tServices(req.query);
        res.json({
            success: true,
            services: result.services,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку послуг'
        });
    }
});

// Отримання послуг клієнта - перемістили перед /:id
router.get('/client/:clientId', authenticate, checkPermission('services.read'), async (req, res) => {
    try {
        const services = await ServiceService.getClientServices(req.params.clientId);
        
        res.json({
            success: true,
            services
        });
    } catch (error) {
        console.error('Error fetching client services:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні послуг клієнта'
        });
    }
});

// Маршрути для рахунків - перемістили перед /:id
router.get('/invoices', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        // Адаптуємо фільтри з запиту
        const filters = {
            page: req.query.page || 1,
            perPage: req.query.perPage || 10,
            sortBy: req.query.sortBy || 'invoice_date',
            descending: req.query.descending === '1' || req.query.descending === 'true',
            search: req.query.search,
            status: req.query.status,
            year: req.query.year,
            month: req.query.month
        };


        const result = await ServiceService.getAllInvoices(filters);
        
        res.json({
            success: true,
            invoices: result.invoices,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку рахунків'
        });
    }
});

// Створення рахунку
router.post('/invoices', authenticate, checkPermission('invoices.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const invoice = await ServiceService.createInvoice(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            invoice
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating invoice:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні рахунку'
        });
    } finally {
        client.release();
    }
});

// Отримання рахунків клієнта
router.get('/invoices/client/:clientId', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const result = await ServiceService.getClientInvoices(req.params.clientId, req.query);
        
        res.json({
            success: true,
            invoices: result.invoices,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching client invoices:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні рахунків клієнта'
        });
    }
});

router.get('/invoices/check-existence', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
      const { objectId, year, month } = req.query;
      
      // Перевірка наявності рахунку для об'єкта за вказаний період
      const invoiceQuery = `
        SELECT i.id, i.invoice_number
        FROM services.invoices i
        JOIN services.invoice_items ii ON i.id = ii.invoice_id
        JOIN services.services s ON ii.service_id = s.id,
        jsonb_array_elements(ii.metadata->'objects') as obj_data
        WHERE i.billing_year = $1 
        AND i.billing_month = $2
        AND i.status = 'issued'
        AND s.service_type = 'object_based'
        AND obj_data->>'id' = $3
        LIMIT 1
      `;
      
      const result = await pool.query(invoiceQuery, [
        parseInt(year), 
        parseInt(month), 
        objectId
      ]);
      
      if (result.rows.length > 0) {
        res.json({
          exists: true,
          invoice_number: result.rows[0].invoice_number,
          invoice_id: result.rows[0].id
        });
      } else {
        res.json({
          exists: false
        });
      }
    } catch (error) {
      console.error('Error checking invoice existence:', error);
      res.status(500).json({
        success: false,
        message: 'Помилка перевірки наявності рахунку'
      });
    }
  });

// Отримання деталей рахунку
router.get('/invoices/:id', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const invoice = await ServiceService.getInvoiceDetails(req.params.id);
        
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Рахунок не знайдено'
            });
        }
        
        res.json({
            success: true,
            invoice
        });
    } catch (error) {
        console.error('Error fetching invoice details:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні деталей рахунку'
        });
    }
});


// Зміна статусу рахунку
router.put('/invoices/:id/status', authenticate, checkPermission('invoices.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const invoice = await ServiceService.updateInvoiceStatus(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            invoice
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating invoice status:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при зміні статусу рахунку'
        });
    } finally {
        client.release();
    }
});

// Завантаження документа для рахунку
router.post('/invoices/:id/documents', authenticate, checkPermission('invoices.update'), upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Файл не завантажено'
            });
        }
        
        await client.query('BEGIN');
        
        // Перевірка наявності рахунку
        const invoiceExists = await client.query(
            'SELECT id FROM services.invoices WHERE id = $1',
            [req.params.id]
        );

        if (invoiceExists.rows.length === 0) {
            throw new Error('Рахунок не знайдено');
        }
        
        // Збереження документа з правильним шляхом
        const relativePath = req.file.path.replace(process.env.UPLOAD_DIR, '').replace(/^\/+/, '');
        
        const result = await client.query(
            `INSERT INTO services.invoice_documents (
                invoice_id, document_name, document_type, 
                file_path, file_size, uploaded_by
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [
                req.params.id,
                req.body.document_name || req.file.originalname,
                req.body.document_type || path.extname(req.file.originalname).substring(1),
                relativePath,
                req.file.size,
                req.user.userId
            ]
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            document: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error uploading document:', error);
        
        // Видалення файлу, якщо він був завантажений
        if (req.file && fs.existsSync(req.file.path)) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (unlinkError) {
                console.error('Error removing uploaded file:', unlinkError);
            }
        }
        
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при завантаженні документа'
        });
    } finally {
        client.release();
    }
});

// Призначення послуги клієнту - перемістили перед /:id
router.post('/assign', authenticate, checkPermission('services.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const assignment = await ServiceService.assignServiceToClient(
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
        console.error('Error assigning service:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при призначенні послуги'
        });
    } finally {
        client.release();
    }
});

// Припинення надання послуги клієнту - перемістили перед /:id
router.post('/terminate/:id', authenticate, checkPermission('services.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const result = await ServiceService.terminateClientService(
            client, 
            req.params.id, 
            req.body, 
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
        console.error('Error terminating service:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при припиненні надання послуги'
        });
    } finally {
        client.release();
    }
});

// Отримання однієї послуги - перемістили після специфічних маршрутів
router.get('/:id', authenticate, checkPermission('services.read'), async (req, res) => {
    try {
        const service = await ServiceService.getServiceById(req.params.id);
        
        if (!service) {
            return res.status(404).json({
                success: false,
                message: 'Послуга не знайдена'
            });
        }
        
        res.json({
            success: true,
            service
        });
    } catch (error) {
        console.error('Error fetching service:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні даних послуги'
        });
    }
});

// Створення послуги
router.post('/', authenticate, checkPermission('services.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const newService = await ServiceService.createService(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            service: newService
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating service:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні послуги'
        });
    } finally {
        client.release();
    }
});

// Оновлення послуги
router.put('/:id', authenticate, checkPermission('services.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const updatedService = await ServiceService.updateService(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            service: updatedService
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating service:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні послуги'
        });
    } finally {
        client.release();
    }
});

// Видалення послуги
router.delete('/:id', authenticate, checkPermission('services.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await ServiceService.deleteService(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Послуга успішно видалена'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting service:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні послуги'
        });
    } finally {
        client.release();
    }
});

// Генерація PDF для рахунку
router.get('/invoices/:id/pdf', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const invoice = await ServiceService.getInvoiceDetails(req.params.id);
        
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Рахунок не знайдено'
            });
        }
        
        // Отримуємо мову користувача з query параметра
        const userLanguage = req.query.lang || 'uk';
        
        // Генеруємо PDF з мовою користувача
        const pdfBuffer = await PDFService.generateInvoicePdf(invoice, userLanguage);
        
        // Відправляємо PDF клієнту
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при генерації PDF'
        });
    }
});


// Генерація рахунків для конкретного клієнта за певний період
router.post('/invoices/generate-for-client/:clientId', authenticate, checkPermission('invoices.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const generatedInvoices = await ServiceService.generateMonthlyInvoices(
            client, 
            req.body.month,
            req.body.year,
            req.user.userId,
            req,
            req.params.clientId // передаємо clientId
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            invoices: generatedInvoices
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error generating invoices for client:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні рахунків для клієнта'
        });
    } finally {
        client.release();
    }
});

// Перевірка можливості створення рахунку (перевірка неоплачених періодів)
router.get('/invoices/check-pending/:clientId', authenticate, checkPermission('invoices.read'), async (req, res) => {
    try {
        const { year, month } = req.query;
        
        // Отримуємо об'єкти клієнта
        const clientObjects = await PaymentService.getClientObjectsWithPayments(
            req.params.clientId,
            year,
            month
        );
        
        // Аналізуємо стан оплати
        const pendingObjects = clientObjects.filter(obj => !obj.is_period_paid);
        const hasPendingPayments = pendingObjects.length > 0;
        
        res.json({
            success: true,
            hasPendingPayments,
            pendingObjects,
            checkedPeriod: {
                year,
                month
            }
        });
    } catch (error) {
        console.error('Error checking pending payments:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при перевірці неоплачених періодів'
        });
    }
});



// Генерація рахунків за певний період
router.post('/invoices/generate', authenticate, checkPermission('invoices.create'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const generatedInvoices = await ServiceService.generateMonthlyInvoices(
        client, 
        req.body.month,
        req.body.year,
        req.user.userId,
        req
      );
      
      await client.query('COMMIT');
      
      res.status(201).json({
        success: true,
        invoices: generatedInvoices
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error generating invoices:', error);
      res.status(400).json({
        success: false,
        message: error.message || 'Помилка при створенні рахунків'
      });
    } finally {
      client.release();
    }
  });

  // Редагування рахунку - додати після існуючих маршрутів рахунків
router.put('/invoices/:id', authenticate, checkPermission('invoices.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const invoice = await ServiceService.updateInvoice(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            invoice
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating invoice:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні рахунку'
        });
    } finally {
        client.release();
    }
});

// Видалення документа з рахунку
router.delete('/invoices/:id/documents/:documentId', authenticate, checkPermission('invoices.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Отримуємо інформацію про документ
        const documentResult = await client.query(
            'SELECT * FROM services.invoice_documents WHERE id = $1 AND invoice_id = $2',
            [req.params.documentId, req.params.id]
        );

        if (documentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Документ не знайдено'
            });
        }

        const document = documentResult.rows[0];
        
        // Видаляємо запис з бази даних
        await client.query(
            'DELETE FROM services.invoice_documents WHERE id = $1',
            [req.params.documentId]
        );
        
        // Видаляємо файл з файлової системи
        const fullFilePath = path.join(process.env.UPLOAD_DIR, document.file_path);
        if (fs.existsSync(fullFilePath)) {
            try {
                fs.unlinkSync(fullFilePath);
            } catch (fileError) {
                console.warn('Warning: Could not delete file from filesystem:', fileError);
                // Не кидаємо помилку, оскільки запис з БД вже видалено
            }
        }

        // Аудит (якщо потрібно)
        await AuditService.log({
            userId: req.user.userId,
            actionType: 'INVOICE_DOCUMENT_DELETE',
            entityType: 'INVOICE_DOCUMENT',
            entityId: req.params.documentId,
            oldValues: document,
            ipAddress: req.ip,
            tableSchema: 'services',
            tableName: 'invoice_documents',
            auditType: AUDIT_TYPES.BUSINESS,
            req
        });
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Документ успішно видалено'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting document:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні документа'
        });
    } finally {
        client.release();
    }
});



module.exports = router;