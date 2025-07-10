const nodemailer = require('nodemailer');
const { pool } = require('../database');

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
}

module.exports = EmailService;