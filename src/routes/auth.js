const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');
const AuditService = require('../services/auditService');
const authenticate = require('../middleware/auth');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const axios = require('axios');

// Login
router.post('/login', async (req, res) => {
  console.log('=== LOGIN ATTEMPT START ===');
  console.log('Request body:', req.body);
  console.log('Request method:', req.method);
  console.log('Request URL:', req.url);
  
  try {
    const { email, password } = req.body;
    console.log('Extracted email:', email);
    console.log('Password provided:', !!password);
    console.log('Password length:', password?.length);
    console.log('Password type:', typeof password);

    console.log('Step 1: Searching for staff user...');
    // Спочатку шукаємо staff користувача (як у вашому простому файлі)
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

    console.log('Staff query completed. Rows found:', result.rows.length);

    // Якщо знайшли staff - обробляємо як раніше
    if (result.rows.length > 0) {
      console.log('Staff user found, processing...');
      const user = result.rows[0];
      
      console.log('User ID:', user.id);
      console.log('User email:', user.email);
      console.log('User active:', user.is_active);
      console.log('Password from DB exists:', !!user.password);
      console.log('Password from DB type:', typeof user.password);
      console.log('Password from DB length:', user.password?.length);
      console.log('Password from DB is null:', user.password === null);
      console.log('Password from DB is undefined:', user.password === undefined);

      if (!user.is_active) {
        console.log('User account is inactive');
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

      // Додаткові перевірки перед bcrypt
      console.log('Preparing for password check...');
      
      if (!user.password || typeof user.password !== 'string') {
        console.error('CRITICAL: Invalid password hash in database');
        console.error('Password value:', user.password);
        console.error('Password type:', typeof user.password);
        return res.status(500).json({ message: 'Database error' });
      }

      if (!password || typeof password !== 'string') {
        console.error('CRITICAL: Invalid password in request');
        console.error('Request password:', password);
        console.error('Request password type:', typeof password);
        return res.status(400).json({ message: 'Invalid password format' });
      }

      console.log('About to call bcrypt.compare...');
      console.log('Input password:', password);
      console.log('Hash from DB:', user.password);
      
      // Перевірка пароля
      let validPassword;
      try {
        validPassword = await bcrypt.compare(password, user.password);
        console.log('bcrypt.compare completed successfully');
        console.log('Password valid:', validPassword);
      } catch (bcryptError) {
        console.error('BCRYPT ERROR:', bcryptError);
        console.error('Bcrypt error name:', bcryptError.name);
        console.error('Bcrypt error message:', bcryptError.message);
        console.error('Bcrypt error stack:', bcryptError.stack);
        return res.status(500).json({ message: 'Password verification error' });
      }
      
      if (!validPassword) {
        console.log('Password validation failed');
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

      console.log('Password validation successful, updating last login...');
      // Оновлення часу останнього входу
      await pool.query(
        'UPDATE auth.users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );
      console.log('Last login updated');

      console.log('Creating JWT token...');
      console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
      
      // Створення токена з правами (ВИПРАВЛЕНО - додано userType)
      const token = jwt.sign(
        { 
          userId: user.id,
          userType: 'staff',  // <- це було відсутнє
          email: user.email,
          permissions: user.permissions.filter(Boolean)
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      console.log('JWT token created');

      console.log('Logging audit...');
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
      console.log('Audit logged successfully');

      console.log('Sending successful response...');
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

    console.log('Staff user not found, checking for client...');
    // Якщо не staff - шукаємо клієнта
    let clientResult;
    try {
      console.log('Querying clients table...');
      clientResult = await pool.query(
        'SELECT * FROM clients.clients WHERE wialon_username = $1 AND is_active = true',
        [email]
      );
      console.log('Client query completed. Rows found:', clientResult.rows.length);
    } catch (error) {
      console.log('Error querying clients table:', error.message);
      // Таблиця клієнтів не існує
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (clientResult.rows.length === 0) {
      console.log('No client found with username:', email);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const client = clientResult.rows[0];
    console.log('Client found:', client.id, client.name);

    console.log('Checking Wialon integration...');
    // Перевіряємо Wialon інтеграцію
    let WialonIntegrationService;
    try {
      WialonIntegrationService = require('../services/wialon-integration.service');
      console.log('Wialon service loaded successfully');
    } catch (error) {
      console.log('Wialon service load error:', error.message);
      return res.status(500).json({ message: 'Wialon integration not available' });
    }

    let tokenData;
    try {
      console.log('Getting Wialon token...');
      tokenData = await WialonIntegrationService.getWialonToken();
      console.log('Wialon token data received:', !!tokenData);
    } catch (error) {
      console.log('Wialon token error:', error.message);
      return res.status(500).json({ message: 'Wialon configuration error' });
    }

    if (!tokenData?.api_url) {
      console.log('Wialon API URL not configured');
      return res.status(500).json({ message: 'Wialon not configured' });
    }

    console.log('Validating with Wialon API...');
    // Перевіряємо з Wialon API
    try {
      const loginResponse = await axios.post(
        `${tokenData.api_url}/wialon/ajax.html`,
        `svc=token/login&params=${encodeURIComponent(JSON.stringify({
          token: password
        }))}`,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        }
      );

      console.log('Wialon API response received');
      if (!loginResponse.data || loginResponse.data.error) {
        console.log('Wialon authentication failed:', loginResponse.data?.error);
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      console.log('Wialon authentication successful');
      // Зберігаємо сесію (якщо таблиця існує)
      let sessionId = null;
      try {
        console.log('Creating client session...');
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
        console.log('Client session created:', sessionId);
      } catch (sessionError) {
        console.log('Session creation failed:', sessionError.message);
        // Таблиця сесій не існує - продовжуємо без неї
      }

      console.log('Creating client JWT token...');
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

      console.log('Logging client audit...');
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

      console.log('Client login successful, sending response...');
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
      console.error('Wialon API error:', wialonError.message);
      return res.status(500).json({ message: 'Authentication service error' });
    }

  } catch (err) {
    console.error('=== LOGIN GLOBAL ERROR ===');
    console.error('Error name:', err.name);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    console.error('==========================');
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