const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');
const { AuditService } = require('../services/auditService');
const authenticate = require('../middleware/auth');

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    
    // Перевірка існування користувача
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE email = $1',
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
      `INSERT INTO users (email, password, first_name, last_name, phone) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, first_name, last_name, phone`,
      [email, hashedPassword, firstName, lastName, phone]
    );

    const user = userResult.rows[0];

    // Логування реєстрації
    await AuditService.log({
      userId: user.id,
      actionType: 'USER_REGISTER',
      entityType: 'USER',
      entityId: user.id,
      newValues: { email, firstName, lastName, phone },
      ipAddress: req.ip
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

    // Знаходимо користувача разом з його ролями
    const result = await pool.query(
      `SELECT 
        u.*,
        array_agg(DISTINCT r.name) as roles,
        array_agg(DISTINCT p.code) as permissions
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       LEFT JOIN role_permissions rp ON r.id = rp.role_id
       LEFT JOIN permissions p ON rp.permission_id = p.id
       WHERE u.email = $1
       GROUP BY u.id`,
      [email]
    );

    if (result.rows.length === 0) {
      await AuditService.log({
        actionType: 'LOGIN_FAILED',
        entityType: 'USER',
        newValues: { email },
        ipAddress: req.ip
      });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      await AuditService.log({
        userId: user.id,
        actionType: 'LOGIN_FAILED',
        entityType: 'USER',
        entityId: user.id,
        newValues: { email, reason: 'Account inactive' },
        ipAddress: req.ip
      });
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    // Перевірка пароля
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      await AuditService.log({
        userId: user.id,
        actionType: 'LOGIN_FAILED',
        entityType: 'USER',
        entityId: user.id,
        newValues: { email },
        ipAddress: req.ip
      });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Оновлення часу останнього входу
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Створення токена
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        permissions: user.permissions
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Логування успішного входу
    await AuditService.log({
      userId: user.id,
      actionType: 'LOGIN_SUCCESS',
      entityType: 'USER',
      entityId: user.id,
      newValues: { email },
      ipAddress: req.ip
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        avatarUrl: user.avatar_url,
        isActive: user.is_active,
        roles: user.roles.filter(Boolean), // Видаляємо null значення
        permissions: user.permissions.filter(Boolean) // Видаляємо null значення
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
       FROM users u 
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       LEFT JOIN role_permissions rp ON r.id = rp.role_id
       LEFT JOIN permissions p ON rp.permission_id = p.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = result.rows[0];
    if (userData.avatar_url) {
      userData.avatar_url = `/uploads/${userData.avatar_url}`;
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