const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const AuditService = require('../services/auditService');

// Отримати всі шаблони
router.get('/', authenticate, checkPermission('company_profile.read'), async (req, res) => {
  try {
    const query = `
      SELECT * FROM company.email_templates
      ORDER BY is_active DESC, name ASC
    `;
    const result = await pool.query(query);
    
    res.json({
      success: true,
      templates: result.rows
    });
  } catch (error) {
    console.error('Error fetching email templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching email templates'
    });
  }
});

// Отримати конкретний шаблон
router.get('/:id', authenticate, checkPermission('company_profile.read'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT * FROM company.email_templates
      WHERE id = $1
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }
    
    res.json({
      success: true,
      template: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching email template:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching email template'
    });
  }
});

// Створити новий шаблон
router.post('/', authenticate, checkPermission('company_profile.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { name, code, subject, body_html, body_text, description, variables, is_active, module_type } = req.body;

    // Перевірка обов'язкових полів
    if (!name || !code || !subject || !body_html) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: name, code, subject, body_html'
      });
    }

    // Перевірка унікальності коду
    const existingTemplate = await client.query(
      'SELECT id FROM company.email_templates WHERE code = $1',
      [code]
    );

    if (existingTemplate.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Template code already exists'
      });
    }

const insertQuery = `
  INSERT INTO company.email_templates (
    name, code, subject, body_html, body_text, description, 
    variables, is_active, module_type, created_by
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING *
`;

const result = await client.query(insertQuery, [
  name,
  code,
  subject,
  body_html,
  body_text || null,
  description || null,
  variables || null,
  is_active !== undefined ? is_active : true,
  module_type || null,
  req.user.userId
]);

    await client.query('COMMIT');

    // Аудит
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'EMAIL_TEMPLATE_CREATE',
      entityType: 'EMAIL_TEMPLATE',
      entityId: result.rows[0].id,
      newValues: req.body,
      ipAddress: req.ip,
      tableSchema: 'company',
      tableName: 'email_templates',
      req
    });

    res.json({
      success: true,
      template: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating email template:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating email template'
    });
  } finally {
    client.release();
  }
});

// Оновити шаблон
router.put('/:id', authenticate, checkPermission('company_profile.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { name, subject, body_html, body_text, description, variables, is_active, module_type } = req.body;

    // Отримання поточних даних для аудиту
    const currentData = await client.query(
      'SELECT * FROM company.email_templates WHERE id = $1',
      [id]
    );

    if (currentData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    const oldData = currentData.rows[0];

const updateQuery = `
  UPDATE company.email_templates 
  SET name = $1, subject = $2, body_html = $3, body_text = $4, 
      description = $5, variables = $6, is_active = $7, module_type = $8, updated_at = CURRENT_TIMESTAMP
  WHERE id = $9
  RETURNING *
`;

const result = await client.query(updateQuery, [
  name || oldData.name,
  subject || oldData.subject,
  body_html || oldData.body_html,
  body_text !== undefined ? body_text : oldData.body_text,
  description !== undefined ? description : oldData.description,
  variables !== undefined ? variables : oldData.variables,
  is_active !== undefined ? is_active : oldData.is_active,
  module_type !== undefined ? module_type : oldData.module_type,
  id
]);

    await client.query('COMMIT');

    // Аудит
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'EMAIL_TEMPLATE_UPDATE',
      entityType: 'EMAIL_TEMPLATE',
      entityId: id,
      oldValues: oldData,
      newValues: req.body,
      ipAddress: req.ip,
      tableSchema: 'company',
      tableName: 'email_templates',
      req
    });

    res.json({
      success: true,
      template: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating email template:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating email template'
    });
  } finally {
    client.release();
  }
});

// Видалити шаблон
router.delete('/:id', authenticate, checkPermission('company_profile.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Отримання поточних даних для аудиту
    const currentData = await client.query(
      'SELECT * FROM company.email_templates WHERE id = $1',
      [id]
    );

    if (currentData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    const oldData = currentData.rows[0];

    await client.query('DELETE FROM company.email_templates WHERE id = $1', [id]);

    await client.query('COMMIT');

    // Аудит
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'EMAIL_TEMPLATE_DELETE',
      entityType: 'EMAIL_TEMPLATE',
      entityId: id,
      oldValues: oldData,
      ipAddress: req.ip,
      tableSchema: 'company',
      tableName: 'email_templates',
      req
    });

    res.json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting email template:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting email template'
    });
  } finally {
    client.release();
  }
});

module.exports = router;