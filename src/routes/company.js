const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { staffOnly } = require('../middleware/clientAccess');
const CompanyService = require('../services/company.service');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const CurrencyService = require('../services/currencyService');

// Налаштування для завантаження файлів
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let uploadDir;
        
        // Визначаємо папку залежно від типу файлу
        if (req.path.includes('/legal-documents')) {
            uploadDir = path.join(process.env.UPLOAD_DIR, 'legal_documents');
        } else if (req.path.includes('/logo')) {
            uploadDir = path.join(process.env.UPLOAD_DIR, 'company_logo');
        } else {
            uploadDir = path.join(process.env.UPLOAD_DIR, 'company_files');
        }
        
        // Створюємо папку, якщо вона не існує
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'company-doc-' + uniqueSuffix + ext);
    }
});

const upload = multer({ storage });

// Отримання даних організації
router.get('/', authenticate, checkPermission('company_profile.read'), async (req, res) => {
    try {
        const organizationDetails = await CompanyService.getOrganizationDetails();
        
        res.json({
            success: true,
            organization: organizationDetails
        });
    } catch (error) {
        console.error('Error fetching organization details:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні даних організації'
        });
    }
});

// Збереження даних організації
router.post('/', authenticate, checkPermission('company_profile.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const result = await CompanyService.saveOrganizationDetails(
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
        console.error('Error saving organization details:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при збереженні даних організації'
        });
    } finally {
        client.release();
    }
});

// Завантаження логотипу компанії
router.post('/logo', authenticate, checkPermission('company_profile.update'), upload.single('logo'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Файл не завантажено'
            });
        }
        
        await client.query('BEGIN');
        
        // Отримання ID організації
        const orgResult = await client.query(
            'SELECT id FROM company.organization_details LIMIT 1'
        );
        
        if (orgResult.rows.length === 0) {
            throw new Error('Необхідно спочатку створити дані організації');
        }
        
        const organizationId = orgResult.rows[0].id;
        const logoPath = req.file.path.replace(process.env.UPLOAD_DIR, '');
        
        // Оновлення шляху до логотипу
        await client.query(
            'UPDATE company.organization_details SET logo_path = $1 WHERE id = $2',
            [logoPath, organizationId]
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            logo_path: logoPath
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error uploading logo:', error);
        
        // Видалення файлу, якщо він був завантажений
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при завантаженні логотипу'
        });
    } finally {
        client.release();
    }
});

// Банківські рахунки
router.get('/bank-accounts', authenticate, checkPermission('company_profile.read'), async (req, res) => {
    try {
        const accounts = await CompanyService.getBankAccounts();
        
        res.json({
            success: true,
            accounts
        });
    } catch (error) {
        console.error('Error fetching bank accounts:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні банківських рахунків'
        });
    }
});

router.post('/bank-accounts', authenticate, checkPermission('company_profile.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const account = await CompanyService.createBankAccount(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            account
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating bank account:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при створенні банківського рахунку'
        });
    } finally {
        client.release();
    }
});

router.put('/bank-accounts/:id', authenticate, checkPermission('company_profile.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const account = await CompanyService.updateBankAccount(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            account
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating bank account:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при оновленні банківського рахунку'
        });
    } finally {
        client.release();
    }
});

router.delete('/bank-accounts/:id', authenticate, checkPermission('company_profile.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await CompanyService.deleteBankAccount(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Банківський рахунок успішно видалено'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting bank account:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні банківського рахунку'
        });
    } finally {
        client.release();
    }
});

// Юридичні документи
router.get('/legal-documents', authenticate, checkPermission('company_profile.read'), async (req, res) => {
    try {
        const documents = await CompanyService.getLegalDocuments();
        
        res.json({
            success: true,
            documents
        });
    } catch (error) {
        console.error('Error fetching legal documents:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні юридичних документів'
        });
    }
});

router.post('/legal-documents', authenticate, checkPermission('company_profile.update'), upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Файл не завантажено'
            });
        }
        
        await client.query('BEGIN');
        
        const document = await CompanyService.uploadLegalDocument(
            client, 
            req.body, 
            req.file, 
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
        console.error('Error uploading legal document:', error);
        
        // Видалення файлу, якщо він був завантажений
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при завантаженні юридичного документа'
        });
    } finally {
        client.release();
    }
});

router.delete('/legal-documents/:id', authenticate, checkPermission('company_profile.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await CompanyService.deleteLegalDocument(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Юридичний документ успішно видалено'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting legal document:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні юридичного документа'
        });
    } finally {
        client.release();
    }
});

// Системні налаштування
router.get('/settings', authenticate, checkPermission('company_profile.read'), async (req, res) => {
    try {
        const settings = await CompanyService.getSystemSettings(req.query.category);
        
        res.json({
            success: true,
            settings
        });
    } catch (error) {
        console.error('Error fetching system settings:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні налаштувань системи'
        });
    }
});

router.get('/settings/:category/:key', authenticate, checkPermission('company_profile.read'), async (req, res) => {
    try {
        const setting = await CompanyService.getSystemSetting(
            req.params.category, 
            req.params.key
        );
        
        if (!setting) {
            return res.status(404).json({
                success: false,
                message: 'Налаштування не знайдено'
            });
        }
        
        res.json({
            success: true,
            setting
        });
    } catch (error) {
        console.error('Error fetching system setting:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні налаштування системи'
        });
    }
});

router.post('/settings', authenticate, checkPermission('company_profile.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const setting = await CompanyService.saveSystemSetting(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            setting
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving system setting:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при збереженні налаштування системи'
        });
    } finally {
        client.release();
    }
});

router.delete('/settings/:id', authenticate, checkPermission('company_profile.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await CompanyService.deleteSystemSetting(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Налаштування успішно видалено'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting system setting:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при видаленні налаштування системи'
        });
    } finally {
        client.release();
    }
});

// Налаштування сповіщень
router.get('/notification-settings', authenticate, staffOnly, checkPermission('company_profile.read'), async (req, res) => {
  try {
    const settings = await CompanyService.getSystemSettings('notifications');
    
    // Перетворюємо в зручний формат
    const notificationSettings = {};
    settings.forEach(setting => {
      const keys = setting.key.split('_');
      const category = keys[0];
      const property = keys.slice(1).join('_');
      
      if (!notificationSettings[category]) {
        notificationSettings[category] = {};
      }
      
      notificationSettings[category][property] = setting.value;
    });
    
    res.json({
      success: true,
      settings: notificationSettings
    });
  } catch (error) {
    console.error('Error fetching notification settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching notification settings'
    });
  }
});

router.put('/notification-settings', authenticate, staffOnly, checkPermission('company_profile.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const notifications = req.body;
    const settings = [];

    // Перетворюємо вкладену структуру в плоскі налаштування
    Object.keys(notifications).forEach(category => {
      Object.keys(notifications[category]).forEach(property => {
        settings.push({
          category: 'notifications',
          key: `${category}_${property}`,
          value: notifications[category][property]?.toString()
        });
      });
    });

    // Зберігаємо налаштування
    for (const setting of settings) {
      await CompanyService.saveSystemSetting(client, setting, req.user.userId, req);
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Notification settings saved successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving notification settings:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Error saving notification settings'
    });
  } finally {
    client.release();
  }
});

// Валютні налаштування
router.get('/currency-settings', authenticate, checkPermission('company.read'), async (req, res) => {
    try {
        const settings = await CurrencyService.getCurrencySettings();
        const supportedCurrencies = CurrencyService.getSupportedCurrencies();
        const formats = CurrencyService.getCurrencyFormats();
        
        res.json({
            success: true,
            settings,
            supportedCurrencies,
            formats
        });
    } catch (error) {
        console.error('Error fetching currency settings:', error);
        res.status(500).json({
            success: false,
            message: 'Помилка при отриманні налаштувань валюти'
        });
    }
});

router.post('/currency-settings', authenticate, checkPermission('company.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const settings = await CurrencyService.saveCurrencySettings(
            client,
            req.body,
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            settings,
            message: 'Налаштування валюти збережено'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error saving currency settings:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Помилка при збереженні налаштувань валюти'
        });
    } finally {
        client.release();
    }
});
module.exports = router;