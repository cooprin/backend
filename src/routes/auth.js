const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');
const AuditService = require('../services/auditService');
const authenticate = require('../middleware/auth');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone } = req.body;
    
    // Перевірка існування користувача
    const userCheck = await pool.query(
      'SELECT * FROM auth.users WHERE email = $1',
      [email]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists!' });
    }

    // Хешування пароля
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Створення користувача
    const userResult = await pool.query(
      `INSERT INTO auth.users (email, password, first_name, last_name, phone) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, first_name, last_name, phone`,
      [email, hashedPassword, first_name, last_name, phone]
    );

    const user = userResult.rows[0];

    // Призначення ролі за замовчуванням
    await pool.query(
      `INSERT INTO auth.user_roles (user_id, role_id)
       SELECT $1, id FROM auth.roles WHERE name = 'user'`,
      [user.id]
    );

    // Логування реєстрації
    await AuditService.log({
      userId: user.id,
      actionType: AUDIT_LOG_TYPES.USER.CREATE,
      entityType: ENTITY_TYPES.USER,
      entityId: user.id,
      newValues: { email, first_name, last_name, phone },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });

    res.status(201).json({
      message: 'User registered successfully',
      user
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      `SELECT 
        u.*,
        array_agg(DISTINCT r.name) as roles,
        array_agg(DISTINCT p.code) as permissions
       FROM auth.users u
       LEFT JOIN auth.user_roles ur ON u.id = ur.user_id
       LEFT JOIN auth.roles r ON ur.role_id = r.id
       LEFT JOIN auth.role_permissions rp ON r.id = rp.role_id
       LEFT JOIN auth.permissions p ON rp.permission_id = p.id
       WHERE u.email = $1
       GROUP BY u.id`,
      [email]
    );

    if (result.rows.length === 0) {
      await AuditService.log({
        actionType: AUDIT_LOG_TYPES.AUTH.LOGIN_FAILED,
        entityType: ENTITY_TYPES.USER,
        newValues: { email },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      await AuditService.log({
        userId: user.id,
        actionType: AUDIT_LOG_TYPES.AUTH.LOGIN_FAILED,
        entityType: ENTITY_TYPES.USER,
        entityId: user.id,
        newValues: { email, reason: 'Account inactive' },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    // Перевірка пароля
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      await AuditService.log({
        userId: user.id,
        actionType: AUDIT_LOG_TYPES.AUTH.LOGIN_FAILED,
        entityType: ENTITY_TYPES.USER,
        entityId: user.id,
        newValues: { email, reason: 'Invalid password' },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Оновлення часу останнього входу
    await pool.query(
      'UPDATE auth.users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Створення токена з правами
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        permissions: user.permissions.filter(Boolean)
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Логування успішного входу
    await AuditService.log({
      userId: user.id,
      actionType: AUDIT_LOG_TYPES.AUTH.LOGIN_SUCCESS,
      entityType: ENTITY_TYPES.USER,
      entityId: user.id,
      newValues: { email },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
        avatar_url: user.avatar_url,
        isActive: user.is_active,
        roles: user.roles.filter(Boolean),
        permissions: user.permissions.filter(Boolean)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        u.id, 
        u.email, 
        u.first_name, 
        u.last_name, 
        u.phone, 
        u.avatar_url, 
        u.is_active, 
        u.last_login,
        array_agg(DISTINCT r.name) as roles,
        array_agg(DISTINCT p.code) as permissions
       FROM auth.users u 
       LEFT JOIN auth.user_roles ur ON u.id = ur.user_id
       LEFT JOIN auth.roles r ON ur.role_id = r.id
       LEFT JOIN auth.role_permissions rp ON r.id = rp.role_id
       LEFT JOIN auth.permissions p ON rp.permission_id = p.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = result.rows[0];
    if (userData.avatar_url) {
      userData.avatar_url = `${userData.avatar_url}`;
    }

    res.json({
      ...userData,
      roles: userData.roles.filter(Boolean),
      permissions: userData.permissions.filter(Boolean)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;