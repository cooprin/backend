const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const ClientService = require('../services/clients.service');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { staffOnly } = require('../middleware/clientAccess');
const EmailService = require('../services/emailService');

// Налаштування для завантаження файлів
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.env.UPLOAD_DIR, 'client_documents');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'client-doc-' + uniqueSuffix + ext);
    }
});

const upload = multer({ storage });

// Search clients (for autocomplete)
router.get('/search', authenticate, staffOnly, async (req, res) => {
  try {
    const { query, limit = 10 } = req.query;

    let whereClause = 'WHERE is_active = true';
    let queryParams = [];
    
    if (query && query.length >= 2) {
      whereClause += ' AND (name ILIKE $1 OR email ILIKE $1)';
      queryParams.push(`%${query}%`);
      queryParams.push(parseInt(limit));
    } else {
      queryParams.push(parseInt(limit));
    }

    const result = await pool.query(
      `SELECT id, name, email 
       FROM clients.clients 
       ${whereClause}
       ORDER BY name 
       LIMIT $${queryParams.length}`,
      queryParams
    );

    res.json({
      success: true,
      clients: result.rows
    });
  } catch (error) {
    console.error('Error searching clients:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// Отримання одного клієнта
router.get('/:id', authenticate, checkPermission('clients.read'), async (req, res) => {
    try {
        const client = await ClientService.getClientById(req.params.id);
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Клієнт не знайдений'
            });
        }
        
        res.json({
            success: true,
            client
        });
    } catch (error) {
        console.error('Error fetching client:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні даних клієнта'
        });
    }
});
// Отримання списку клієнтів
router.get('/', authenticate, checkPermission('clients.read'), async (req, res) => {
    try {
        const result = await ClientService.getClients(req.query);
        res.json({
            success: true,
            clients: result.clients,
            total: result.total
        });
    } catch (error) {
        console.error('Error fetching clients:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні списку клієнтів'
        });
    }
});


// Отримання інформації про оплату клієнта в Wialon
router.get('/:id/payment-status', authenticate, checkPermission('clients.read'), async (req, res) => {
    try {
        const paymentInfo = await ClientService.getClientPaymentInfo(req.params.id);
        
        res.json({
            success: true,
            paymentInfo
        });
    } catch (error) {
        console.error('Error fetching client payment status:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Помилка при отриманні платіжної інформації'
        });
    }
});

// Створення клієнта
router.post('/', authenticate, checkPermission('clients.create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Валідація обов'язкових полів
        const { name } = req.body;
        if (!name || name.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Назва клієнта є обов\'язковою'
            });
        }

        // Валідація email якщо вказано
        if (req.body.email && req.body.email.trim() !== '') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(req.body.email.trim())) {
                return res.status(400).json({
                    success: false,
                    message: 'Невірний формат email адреси'
                });
            }
        }

        // Валідація Wialon Resource ID якщо вказано
        if (req.body.wialon_resource_id && req.body.wialon_resource_id.trim() !== '') {
            const wialonResourceId = req.body.wialon_resource_id.trim();
            if (!/^\d+$/.test(wialonResourceId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Wialon Resource ID повинен містити лише цифри'
                });
            }
        }

        // Валідація Wialon User ID якщо вказано
        if (req.body.wialon_id && req.body.wialon_id.trim() !== '') {
            const wialonUserId = req.body.wialon_id.trim();
            if (!/^\d+$/.test(wialonUserId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Wialon User ID повинен містити лише цифри'
                });
            }
        }
        
        const newClient = await ClientService.createClient(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            client: newClient
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating client:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні клієнта'
        });
    } finally {
        client.release();
    }
});

// Оновлення клієнта
router.put('/:id', authenticate, checkPermission('clients.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Валідація обов'язкових полів
        if (req.body.name !== undefined && (!req.body.name || req.body.name.trim() === '')) {
            return res.status(400).json({
                success: false,
                message: 'Назва клієнта є обов\'язковою'
            });
        }

        // Валідація email якщо вказано
        if (req.body.email !== undefined && req.body.email && req.body.email.trim() !== '') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(req.body.email.trim())) {
                return res.status(400).json({
                    success: false,
                    message: 'Невірний формат email адреси'
                });
            }
        }

        // Валідація Wialon Resource ID якщо вказано
        if (req.body.wialon_resource_id !== undefined && req.body.wialon_resource_id && req.body.wialon_resource_id.trim() !== '') {
            const wialonResourceId = req.body.wialon_resource_id.trim();
            if (!/^\d+$/.test(wialonResourceId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Wialon Resource ID повинен містити лише цифри'
                });
            }
        }

        // Валідація Wialon User ID якщо вказано
        if (req.body.wialon_id !== undefined && req.body.wialon_id && req.body.wialon_id.trim() !== '') {
            const wialonUserId = req.body.wialon_id.trim();
            if (!/^\d+$/.test(wialonUserId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Wialon User ID повинен містити лише цифри'
                });
            }
        }
        
        const updatedClient = await ClientService.updateClient(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            client: updatedClient
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating client:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні клієнта'
        });
    } finally {
        client.release();
    }
});

// Видалення клієнта
router.delete('/:id', authenticate, checkPermission('clients.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await ClientService.deleteClient(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Клієнт успішно видалений'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting client:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні клієнта'
        });
    } finally {
        client.release();
    }
});

// Завантаження документа для клієнта
router.post('/:id/documents', authenticate, checkPermission('clients.update'), upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Файл не завантажено'
            });
        }
        
        await client.query('BEGIN');
        
        const documentData = {
            document_name: req.body.document_name || req.file.originalname,
            document_type: req.body.document_type || path.extname(req.file.originalname).substring(1),
            file_path: req.file.path.replace(process.env.UPLOAD_DIR, ''),
            file_size: req.file.size,
            description: req.body.description
        };
        
        const document = await ClientService.addDocument(
            client, 
            req.params.id, 
            documentData, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            document
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error uploading document:', error);
        
        // Видалення файлу, якщо він був завантажений
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при завантаженні документа'
        });
    } finally {
        client.release();
    }
});

// Видалення документа клієнта
router.delete('/:clientId/documents/:documentId', authenticate, checkPermission('clients.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await ClientService.deleteDocument(
            client, 
            req.params.documentId, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Документ успішно видалений'
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

// Відправка email клієнту
router.post('/:id/send-email', authenticate, checkPermission('clients.update'), async (req, res) => {
    try {
        const clientId = req.params.id;
        const { templateCode } = req.body;
        
        // Перевіряємо чи існує клієнт
        const clientExists = await pool.query(
            'SELECT id, name, email FROM clients.clients WHERE id = $1',
            [clientId]
        );

        if (clientExists.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Клієнта не знайдено'
            });
        }

        const client = clientExists.rows[0];

        // Перевіряємо чи є email у клієнта
        if (!client.email) {
            return res.status(400).json({
                success: false,
                message: 'У клієнта не вказано email адресу'
            });
        }

        // Відправляємо email з вказаним шаблоном або дефолтним
        const result = await EmailService.sendModuleEmail(
            'client',
            templateCode || 'welcome_client',
            clientId,
            client.email
        );
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Email успішно відправлено',
                messageId: result.messageId
            });
        } else {
            res.status(400).json({
                success: false,
                message: result.reason || 'Не вдалося відправити email',
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error sending client email:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при відправці email'
        });
    }
});



module.exports = router;