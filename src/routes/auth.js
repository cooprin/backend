const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');
const AuditService = require('../services/auditService');
const authenticate = require('../middleware/auth');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const axios = require('axios');

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Логування спроби входу
    console.log('=== LOGIN ATTEMPT ===');
    console.log('Username/Email:', email);
    console.log('Password length:', password?.length);
    console.log('IP Address:', req.ip);
    console.log('User Agent:', req.headers['user-agent']);
    console.log('Timestamp:', new Date().toISOString());

    // Спочатку шукаємо staff користувача
    const staffResult = await pool.query(
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

    // Якщо знайшли staff - обробляємо як раніше
    if (staffResult.rows.length > 0) {
      console.log('✓ Staff user found:', email);
      const user = staffResult.rows[0];

      if (!user.is_active) {
        console.log('✗ Staff account inactive');
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
      const validPassword = await bcryptjs.compare(password, user.password);
      if (!validPassword) {
        console.log('✗ Invalid staff password');
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
          userType: 'staff',
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

      console.log('✓ Staff login successful');
      return res.json({
        token,
        userType: 'staff',
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
    }

    console.log('Staff not found, checking for Wialon client...');

    // Якщо не staff - шукаємо клієнта
    let clientResult;
    try {
      clientResult = await pool.query(
        'SELECT * FROM clients.clients WHERE wialon_username = $1 AND is_active = true',
        [email]
      );
      console.log('Client query result:', clientResult.rows.length, 'rows');
    } catch (error) {
      console.log('✗ Clients table error:', error.message);
      // Таблиця клієнтів не існує
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (clientResult.rows.length === 0) {
      console.log('✗ Client not found with username:', email);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const client = clientResult.rows[0];
    console.log('✓ Client found:', client.name, 'ID:', client.id);

    // Перевіряємо Wialon інтеграцію
    let WialonIntegrationService;
    try {
      WialonIntegrationService = require('../services/wialon-integration.service');
      console.log('✓ Wialon service loaded');
    } catch (error) {
      console.log('✗ Wialon service error:', error.message);
      return res.status(500).json({ message: 'Wialon integration not available' });
    }

    let tokenData;
    try {
      tokenData = await WialonIntegrationService.getWialonToken();
      console.log('✓ Wialon token obtained');
    } catch (error) {
      console.log('✗ Wialon token error:', error.message);
      return res.status(500).json({ message: 'Wialon configuration error' });
    }

    if (!tokenData?.api_url) {
      console.log('✗ Wialon API URL not configured');
      return res.status(500).json({ message: 'Wialon not configured' });
    }

    console.log('Wialon API URL:', tokenData.api_url);

    // Перевіряємо з Wialon API
    try {
      console.log('→ Sending login request to Wialon API...');
      const loginResponse = await axios.post(
        `${tokenData.api_url}/wialon/ajax.html`,
        `svc=core/login&params=${encodeURIComponent(JSON.stringify({
          user: email,  // Wialon username
          password: password  // Wialon password
        }))}`,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        }
      );

      console.log('← Wialon API response status:', loginResponse.status);
      console.log('← Wialon API response data:', JSON.stringify(loginResponse.data, null, 2));

      if (!loginResponse.data || loginResponse.data.error) {
        console.log('✗ Wialon authentication failed');
        console.log('Error details:', loginResponse.data?.error);
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      console.log('✓ Wialon authentication successful');
      console.log('Wialon session ID:', loginResponse.data.eid);

      // Зберігаємо сесію (якщо таблиця існує)
      let sessionId = null;
      try {
        const sessionResult = await pool.query(
          `INSERT INTO customer_portal.client_sessions 
           (client_id, wialon_session_id, wialon_token, expires_at, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            client.id,
            loginResponse.data.eid,
            password,
            new Date(Date.now() + 24 * 60 * 60 * 1000),
            req.ip,
            req.headers['user-agent']
          ]
        );
        sessionId = sessionResult.rows[0].id;
        console.log('✓ Client session created:', sessionId);
      } catch (sessionError) {
        console.log('⚠ Session creation failed:', sessionError.message);
        // Таблиця сесій не існує - продовжуємо без неї
      }

      // Створюємо JWT для клієнта
      const token = jwt.sign(
        {
          clientId: client.id,
          userType: 'client',
          wialonUsername: client.wialon_username,
          sessionId,
          permissions: ['customer_portal.read', 'tickets.read', 'tickets.create', 'chat.read', 'chat.create']
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      await AuditService.log({
        actionType: AUDIT_LOG_TYPES.AUTH.LOGIN_SUCCESS,
        entityType: 'CLIENT',
        newValues: { 
          client_id: client.id, 
          wialon_username: email 
        },
        ipAddress: req.ip,
        auditType: AUDIT_TYPES.BUSINESS,
        req
      });

      console.log('✓ Client login successful');
      return res.json({
        token,
        userType: 'client',
        client: {
          id: client.id,
          name: client.name,
          email: client.email,
          phone: client.phone,
          wialon_username: client.wialon_username
        }
      });

    } catch (wialonError) {
      console.log('✗ Wialon API error:', wialonError.message);
      console.log('Error code:', wialonError.code);
      console.log('Error response:', wialonError.response?.data);
      return res.status(500).json({ message: 'Authentication service error' });
    }

  } catch (err) {
    console.error('✗ Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    if (req.user.userType === 'staff') {
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
        userType: 'staff',
        ...userData,
        roles: userData.roles.filter(Boolean),
        permissions: userData.permissions.filter(Boolean)
      });
    } else if (req.user.userType === 'client') {
      try {
        const result = await pool.query(
          'SELECT * FROM clients.clients WHERE id = $1',
          [req.user.clientId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ message: 'Client not found' });
        }

        const client = result.rows[0];
        res.json({
          userType: 'client',
          id: client.id,
          name: client.name,
          email: client.email,
          phone: client.phone,
          wialon_username: client.wialon_username,
          permissions: req.user.permissions
        });
      } catch (error) {
        res.status(500).json({ message: 'Error fetching client data' });
      }
    } else {
      res.status(400).json({ message: 'Invalid user type' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;