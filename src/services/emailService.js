const nodemailer = require('nodemailer');
const { pool } = require('../database');
const { EMAIL_DEFAULTS } = require('../constants/emailDefaults');
const fs = require('fs');
const path = require('path');

class EmailService {
  // Отримати налаштування email для відправки
// Отримати налаштування email для відправки
static async getActiveEmailSettings() {
  try {
    const result = await pool.query(
      `SELECT key, value FROM company.system_settings 
       WHERE category = 'email'`
    );
    
    if (result.rows.length === 0) {
      return null;
    }

    // Перетворюємо масив в об'єкт налаштувань
    const settings = result.rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    return {
      email_address: settings.email_address,
      display_name: settings.display_name,
      smtp_server: settings.smtp_server,
      smtp_port: parseInt(settings.smtp_port) || 587,
      smtp_username: settings.smtp_username,
      smtp_password: settings.smtp_password,
      use_ssl: settings.use_ssl === 'true'
    };
  } catch (error) {
    console.error('Error getting email settings:', error);
    throw error;
  }
}

// Створити транспорт для відправки
static async createTransporter() {
  try {
    const settings = await this.getActiveEmailSettings();
    
    if (!settings) {
      throw new Error('No active email settings found');
    }

    const transportConfig = {
      host: settings.smtp_server,
      port: settings.smtp_port,
      secure: settings.use_ssl, // true для порту 465, false для інших
      auth: {
        user: settings.smtp_username || settings.email_address,
        pass: settings.smtp_password
      },
      tls: {
        rejectUnauthorized: false // для Gmail
      }
    };

    return nodemailer.createTransport(transportConfig); // <-- ВИПРАВЛЕНО
  } catch (error) {
    console.error('Error creating email transporter:', error);
    throw error;
  }
}

  // Тестування з'єднання
  static async testConnection() {
    try {
      const transporter = await this.createTransporter();
      await transporter.verify();
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      console.error('Email connection test failed:', error);
      return { 
        success: false, 
        message: error.message || 'Connection failed' 
      };
    }
  }

  // Додати email до черги
  static async addToQueue(emailData) {
    try {
      const { recipient, subject, bodyHtml, bodyText, cc, bcc, templateId } = emailData;
      
      const result = await pool.query(
        `INSERT INTO company.email_queue 
         (recipient, subject, body_html, body_text, cc, bcc, template_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING *`,
        [recipient, subject, bodyHtml, bodyText, cc, bcc, templateId]
      );
      
      return result.rows[0];
    } catch (error) {
      console.error('Error adding email to queue:', error);
      throw error;
    }
  }

  // Відправити email одразу
  static async sendEmail(emailData) {
    try {
      const transporter = await this.createTransporter();
      const settings = await this.getActiveEmailSettings();
      
      const mailOptions = {
        from: `${settings.display_name || 'System'} <${settings.email_address}>`,
        to: emailData.recipient,
        subject: emailData.subject,
        html: emailData.bodyHtml,
        text: emailData.bodyText,
        cc: emailData.cc,
        bcc: emailData.bcc
      };

      const result = await transporter.sendMail(mailOptions);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  }
  // Отримати шаблон за кодом
  static async getTemplateByCode(templateCode) {
    try {
      const result = await pool.query(
        'SELECT * FROM company.email_templates WHERE code = $1 AND is_active = true',
        [templateCode]
      );
      
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      console.error('Error getting email template:', error);
      throw error;
    }
  }

  // Рендер шаблону з змінними
  static renderTemplate(template, variables = {}) {
    try {
      // Простий рендер змінних у форматі {{variable}}
      let renderedHtml = template.body_html;
      let renderedText = template.body_text || '';
      let renderedSubject = template.subject;

      // Заміна змінних в HTML
      Object.keys(variables).forEach(key => {
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
        const value = variables[key] || '';
        
        renderedHtml = renderedHtml.replace(regex, value);
        renderedText = renderedText.replace(regex, value);
        renderedSubject = renderedSubject.replace(regex, value);
      });

      return {
        subject: renderedSubject,
        bodyHtml: renderedHtml,
        bodyText: renderedText
      };
    } catch (error) {
      console.error('Error rendering template:', error);
      throw error;
    }
  }

  // Відправити email з шаблоном
  static async sendEmailWithTemplate(templateCode, recipient, variables = {}, options = {}) {
    try {
      const template = await this.getTemplateByCode(templateCode);
      
      if (!template) {
        throw new Error(`Email template '${templateCode}' not found`);
      }

      const rendered = this.renderTemplate(template, variables);

      const emailData = {
        recipient,
        subject: rendered.subject,
        bodyHtml: rendered.bodyHtml,
        bodyText: rendered.bodyText,
        cc: options.cc,
        bcc: options.bcc,
        templateId: template.id
      };

      // Якщо відправляти одразу
      if (options.sendImmediate !== false) {
        return await this.sendEmail(emailData);
      } else {
        // Додати до черги
        return await this.addToQueue(emailData);
      }
    } catch (error) {
      console.error('Error sending email with template:', error);
      throw error;
    }
  }
  // Основний метод для відправки email з модулів
static async sendModuleEmail(moduleType, templateCode, entityId, recipient, customVariables = {}) {
  try {
    const template = await this.getTemplateByCode(templateCode);
    
    if (!template) {
      throw new Error(`Email template '${templateCode}' not found`);
    }

    // Отримуємо дані залежно від типу модуля
    const entityData = await this.getModuleData(moduleType, entityId);
    
    if (!entityData) {
      throw new Error(`${moduleType} with ID ${entityId} not found`);
    }

    // Формуємо змінні для шаблону
    const variables = await this.buildModuleVariables(moduleType, entityData, customVariables);

    const rendered = this.renderTemplate(template, variables);

    const emailData = {
      recipient,
      subject: rendered.subject,
      bodyHtml: rendered.bodyHtml,
      bodyText: rendered.bodyText,
      templateId: template.id
    };

    return await this.sendEmail(emailData);
  } catch (error) {
    console.error('Error sending module email:', error);
    throw error;
  }
}

// Отримання даних залежно від типу модуля
static async getModuleData(moduleType, entityId) {
  switch (moduleType) {
    case 'invoice':
      return await this.getInvoiceData(entityId);
    case 'payment':
      return await this.getPaymentData(entityId);
    case 'client':
      return await this.getClientData(entityId);
    case 'service':
      return await this.getServiceData(entityId);
    default:
      throw new Error(`Unknown module type: ${moduleType}`);
  }
}

// Отримання даних рахунку
static async getInvoiceData(invoiceId) {
  try {
    const result = await pool.query(`
      SELECT 
        i.*,
        c.name as client_name,
        c.email as client_email,
        c.address as client_address,
        to_char(i.invoice_date, 'DD.MM.YYYY') as formatted_invoice_date,
        to_char(make_date(i.billing_year, i.billing_month, 1), 'FMMonth YYYY') as billing_period_text
      FROM services.invoices i
      JOIN clients.clients c ON i.client_id = c.id
      WHERE i.id = $1
    `, [invoiceId]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error getting invoice data:', error);
    throw error;
  }
}

// Отримання даних платежу
static async getPaymentData(paymentId) {
  try {
    const result = await pool.query(`
      SELECT 
        p.*,
        c.name as client_name,
        c.email as client_email,
        to_char(p.payment_date, 'DD.MM.YYYY') as formatted_payment_date
      FROM billing.payments p
      JOIN clients.clients c ON p.client_id = c.id
      WHERE p.id = $1
    `, [paymentId]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error getting payment data:', error);
    throw error;
  }
}

// Отримання даних клієнта
// Отримання даних клієнта
static async getClientData(clientId) {
  try {
    const result = await pool.query(`
      SELECT 
        c.*,
        to_char(c.created_at, 'DD.MM.YYYY') as formatted_created_date
      FROM clients.clients c
      WHERE c.id = $1
    `, [clientId]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error getting client data:', error);
    throw error;
  }
}

// Отримання даних послуги
static async getServiceData(serviceId) {
  try {
    const result = await pool.query(`
      SELECT *
      FROM services.services
      WHERE id = $1
    `, [serviceId]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error getting service data:', error);
    throw error;
  }
}
  
// Формування змінних для шаблону
static async buildModuleVariables(moduleType, entityData, customVariables = {}) {
  try {
    // Отримуємо дані компанії
    const companyResult = await pool.query(`
      SELECT legal_name, short_name, legal_address, phone, email, website, logo_path
      FROM company.organization_details 
      LIMIT 1
    `);
    
    const companyData = companyResult.rows[0] || {};
    
    // Читаємо логотип як base64
    let logoBase64 = '';
    if (companyData.logo_path) {
      try {
        const logoPath = path.join(process.env.UPLOAD_DIR, companyData.logo_path.substring(1));
        console.log('Trying to read logo from:', logoPath);
        
        if (fs.existsSync(logoPath)) {
          const logoBuffer = fs.readFileSync(logoPath);
          const mimeType = companyData.logo_path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
          logoBase64 = `data:${mimeType};base64,${logoBuffer.toString('base64')}`;
          console.log('Logo loaded successfully, size:', logoBuffer.length, 'bytes');
        } else {
          console.log('Logo file not found:', logoPath);
        }
      } catch (error) {
        console.error('Error reading logo file:', error);
      }
    } else {
      console.log('No logo_path in company data');
    }
    
    // Базові змінні компанії
    const variables = {
      company_name: companyData.legal_name || companyData.short_name || 'Наша компанія',
      company_address: companyData.legal_address || '',
      company_phone: companyData.phone || '',
      company_email: companyData.email || '',
      company_website: companyData.website || '',
      company_logo_url: logoBase64,
      logo_display_style: logoBase64 ? 'display: block;' : 'display: none;',
      portal_url: EMAIL_DEFAULTS.portal_url,
      ...customVariables
    };

    // Додаємо змінні залежно від типу модуля
    switch (moduleType) {
      case 'invoice':
        Object.assign(variables, {
          invoice_number: entityData.invoice_number || '2024-0001',
          invoice_date: entityData.formatted_invoice_date || new Date().toLocaleDateString('uk-UA'),
          client_name: entityData.client_name || 'Клієнт',
          billing_period: entityData.billing_period_text || 'Не вказано',
          total_amount: entityData.total_amount ? new Intl.NumberFormat('uk-UA').format(entityData.total_amount) : '0,00',
          due_date: new Date(Date.now() + EMAIL_DEFAULTS.payment_due_days * 24 * 60 * 60 * 1000).toLocaleDateString('uk-UA')
        });
        break;
        
      case 'payment':
        Object.assign(variables, {
          payment_amount: entityData.amount ? new Intl.NumberFormat('uk-UA').format(entityData.amount) : '0,00',
          payment_date: entityData.formatted_payment_date || new Date().toLocaleDateString('uk-UA'),
          client_name: entityData.client_name || 'Клієнт'
        });
        break;
        
      case 'client':
        Object.assign(variables, {
          client_name: entityData.name || 'Клієнт',
          client_email: entityData.email || '',
          client_phone: entityData.phone || '',
          client_address: entityData.address || '',
          contact_person: entityData.contact_person || '',
          registration_date: entityData.formatted_created_date || new Date().toLocaleDateString('uk-UA')
        });
        break;
        
      case 'service':
        Object.assign(variables, {
          service_name: entityData.name || 'Послуга',
          service_description: entityData.description || ''
        });
        break;
    }

    return variables;
  } catch (error) {
    console.error('Error building module variables:', error);
    throw error;
  }
}
}


module.exports = EmailService;