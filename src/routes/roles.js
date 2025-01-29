const express = require('express');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const { AuditService, auditLogTypes } = require('../services/auditService');
const router = express.Router();
const { authenticate } = require('./auth');

// Authentication middleware
const authenticate = (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) {
        return res.status(401).json({ message: 'Token is missing' });
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({ message: 'Invalid token' });
    }
  };


// Get all roles with pagination, sorting and search
router.get('/', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 10;
    const offset = (page - 1) * perPage;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'name';
    const descending = req.query.descending === 'true';
    
    const orderDirection = descending ? 'DESC' : 'ASC';
    
    // Build search condition
    const searchCondition = search 
      ? `WHERE name ILIKE $3 OR description ILIKE $3`
      : '';
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) 
      FROM roles 
      ${searchCondition}
    `;
    
    // Get roles
    const rolesQuery = `
      SELECT id, name, description, created_at, updated_at
      FROM roles
      ${searchCondition}
      ORDER BY ${sortBy} ${orderDirection}
      LIMIT $1 OFFSET $2
    `;
    
    const params = [perPage, offset];
    if (search) {
      params.push(`%${search}%`);
    }
    
    const [countResult, rolesResult] = await Promise.all([
      pool.query(countQuery, search ? [`%${search}%`] : []),
      pool.query(rolesQuery, params)
    ]);

    // Логуємо перегляд списку ролей
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLES_LIST_VIEW',
      entityType: 'ROLE',
      ipAddress: req.ip,
      newValues: { page, perPage, search, sortBy, descending }
    });

    res.json({
      roles: rolesResult.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching roles:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while fetching roles'
    });
  }
});

// Create new role
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, description } = req.body;
    
    const existingRole = await pool.query('SELECT id FROM roles WHERE name = $1', [name]);
    if (existingRole.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Role name already exists'
      });
    }
    
    const { rows } = await pool.query(
      `INSERT INTO roles (name, description, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, description, created_at, updated_at`,
      [name, description]
    );

    // Логуємо створення ролі
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLE_CREATE',
      entityType: 'ROLE',
      entityId: rows[0].id,
      newValues: { name, description },
      ipAddress: req.ip
    });
    
    res.status(201).json({
      success: true,
      role: rows[0]
    });
  } catch (error) {
    console.error('Error creating role:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while creating role'
    });
  }
});

// Update role
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    
    // Отримуємо старі дані для логування
    const oldRoleData = await pool.query(
      'SELECT name, description FROM roles WHERE id = $1',
      [id]
    );
    
    const existingRole = await pool.query(
      'SELECT id FROM roles WHERE name = $1 AND id != $2',
      [name, id]
    );
    if (existingRole.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Role name already exists'
      });
    }
    
    const { rows } = await pool.query(
      `UPDATE roles 
       SET name = $1,
           description = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, name, description, created_at, updated_at`,
      [name, description, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    // Логуємо оновлення ролі
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLE_UPDATE',
      entityType: 'ROLE',
      entityId: id,
      oldValues: oldRoleData.rows[0],
      newValues: { name, description },
      ipAddress: req.ip
    });
    
    res.json({
      success: true,
      role: rows[0]
    });
  } catch (error) {
    console.error('Error updating role:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      entityId: req.params.id,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while updating role'
    });
  }
});

// Delete role
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Отримуємо дані ролі перед видаленням для логування
    const roleData = await pool.query(
      'SELECT * FROM roles WHERE id = $1',
      [id]
    );
    
    const usersWithRole = await pool.query(
      'SELECT COUNT(*) FROM users WHERE role_id = $1',
      [id]
    );
    
    if (parseInt(usersWithRole.rows[0].count) > 0) {
      // Логуємо спробу видалення використовуваної ролі
      await AuditService.log({
        userId: req.user.userId,
        actionType: 'ROLE_DELETE_ATTEMPT',
        entityType: 'ROLE',
        entityId: id,
        oldValues: roleData.rows[0],
        newValues: { error: 'Role is in use' },
        ipAddress: req.ip
      });
      return res.status(400).json({
        success: false,
        message: 'Cannot delete role that is assigned to users'
      });
    }
    
    const { rows } = await pool.query(
      'DELETE FROM roles WHERE id = $1 RETURNING id',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    // Логуємо успішне видалення ролі
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ROLE_DELETE',
      entityType: 'ROLE',
      entityId: id,
      oldValues: roleData.rows[0],
      ipAddress: req.ip
    });
    
    res.json({
      success: true,
      message: 'Role deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting role:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'ROLE',
      entityId: req.params.id,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while deleting role'
    });
  }
});

module.exports = router;