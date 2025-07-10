const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const EmailService = require('../services/emailService');
const CompanyService = require('../services/company.service');

// Отримати налаштування email
router.get('/settings', authenticate, checkPermission('company_profile.read'), async (req, res) => {
  try {
    const settings = await CompanyService.getSystemSettings('email');
    
    // Приховуємо паролі в відповіді
    const safeSettings = settings.map(setting => {
      if (setting.key === 'smtp_password') {
        return {
          ...setting,
          value: setting.value ? '••••••••' : ''
        };
      }
      return setting;
    });

    res.json({
      success: true,
      settings: safeSettings
    });
  } catch (error) {
    console.error('Error fetching email settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching email settings'
    });
  }
});

// Зберегти налаштування email
router.post('/settings', authenticate, checkPermission('company_profile.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { 
      email_address, 
      display_name, 
      smtp_server, 
      smtp_port, 
      smtp_username, 
      smtp_password,
      use_ssl 
    } = req.body;

    // Зберігаємо кожне налаштування окремо
    const settings = [
      { category: 'email', key: 'email_address', value: email_address },
      { category: 'email', key: 'display_name', value: display_name },
      { category: 'email', key: 'smtp_server', value: smtp_server },
      { category: 'email', key: 'smtp_port', value: smtp_port.toString() },
      { category: 'email', key: 'smtp_username', value: smtp_username },
      { category: 'email', key: 'use_ssl', value: use_ssl.toString() }
    ];

    // Зберігаємо пароль тільки якщо він не порожній
    if (smtp_password && smtp_password !== '••••••••') {
      settings.push({ 
        category: 'email', 
        key: 'smtp_password', 
        value: smtp_password 
      });
    }

    for (const setting of settings) {
      await CompanyService.saveSystemSetting(client, setting, req.user.userId, req);
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Email settings saved successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving email settings:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Error saving email settings'
    });
  } finally {
    client.release();
  }
});

// Тестувати з'єднання
router.post('/test-connection', authenticate, checkPermission('company_profile.read'), async (req, res) => {
  try {
    const result = await EmailService.testConnection();
    res.json(result);
  } catch (error) {
    console.error('Error testing email connection:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error testing connection'
    });
  }
});

// Відправити тестовий email
router.post('/send-test', authenticate, checkPermission('company_profile.update'), async (req, res) => {
  try {
    const { recipient } = req.body;
    
    if (!recipient) {
      return res.status(400).json({
        success: false,
        message: 'Recipient email is required'
      });
    }

    const emailData = {
      recipient,
      subject: 'Test Email from CRM System',
      bodyHtml: '<h1>Test Email</h1><p>This is a test email from your CRM system. Email configuration is working correctly!</p>',
      bodyText: 'Test Email - This is a test email from your CRM system. Email configuration is working correctly!'
    };

    await EmailService.sendEmail(emailData);

    res.json({
      success: true,
      message: 'Test email sent successfully'
    });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error sending test email'
    });
  }
});

module.exports = router;