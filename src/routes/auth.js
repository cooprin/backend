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
      console.log('✓ Wialon configuration loaded');
    } catch (error) {
      console.log('✗ Wialon token error:', error.message);
      return res.status(500).json({ message: 'Wialon configuration error' });
    }

    if (!tokenData?.api_url) {
      console.log('✗ Wialon API URL not configured');
      return res.status(500).json({ message: 'Wialon not configured' });
    }

    console.log('Wialon API URL:', tokenData.api_url);

    // Спробуємо отримати токен через нову Wialon авторизацію
    try {
      console.log('→ Attempting new Wialon token-based authentication...');
      
      // Визначаємо базовий URL для Wialon Hosting
      const wialonBaseUrl = tokenData.api_url.includes('hst-api') 
        ? 'https://hosting.wialon.com' 
        : tokenData.api_url.replace('/wialon/ajax.html', '').replace('hst-api', 'hosting');
      
      console.log('Using Wialon base URL:', wialonBaseUrl);

      // Спосіб 1: POST запит до oauth.html (як в форумі Wialon)
      let wialonToken = null;
      
      try {
        console.log('→ Trying POST to oauth.html...');
        
        const oauthParams = {
          client_id: 'CustomApp',
          response_type: 'token',
          access_type: -1, // повний доступ
          activation_time: 0,
          duration: 3600, // 1 година в секундах
          flags: 1, // повернути username
          login: email,
          passw: password,
          redirect_uri: `${wialonBaseUrl}/post_token.html`
        };

        const oauthResponse = await axios.post(
          `${wialonBaseUrl}/oauth.html`,
          new URLSearchParams(oauthParams).toString(),
          {
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (compatible; CustomApp/1.0)'
            },
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: function (status) {
              return status >= 200 && status < 400;
            }
          }
        );

        console.log('← OAuth POST response status:', oauthResponse.status);
        
        // Парсимо токен з відповіді
        if (oauthResponse.data && typeof oauthResponse.data === 'string') {
          // Шукаємо токен в HTML відповіді
          const tokenMatch = oauthResponse.data.match(/access_token[=:][\s]*["']?([a-fA-F0-9]{72})["']?/);
          if (tokenMatch) {
            wialonToken = tokenMatch[1];
            console.log('✓ Token found in POST response');
          }
        }
              } catch (postError) {
        console.log('⚠ POST to oauth.html failed:', postError.message);
        console.log('POST oauth.html error details:', {
          status: postError.response?.status,
          statusText: postError.response?.statusText,
          data: postError.response?.data,
          url: `${wialonBaseUrl}/oauth.html`
        });
      }

      // Спосіб 2: POST запит до login.html (якщо перший не спрацював)
      if (!wialonToken) {
        try {
          console.log('→ Trying POST to login.html...');
          
          const loginParams = {
            client_id: 'CustomApp',
            access_type: -1,
            activation_time: 0,
            duration: 3600,
            flags: 1,
            user: email, // тут може бути user замість login
            password: password
          };

          const loginResponse = await axios.post(
            `${wialonBaseUrl}/login.html`,
            new URLSearchParams(loginParams).toString(),
            {
              headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (compatible; CustomApp/1.0)'
              },
              timeout: 15000,
              maxRedirects: 5,
              validateStatus: function (status) {
                return status >= 200 && status < 400;
              }
            }
          );

          console.log('← Login POST response status:', loginResponse.status);
          
          if (loginResponse.data && typeof loginResponse.data === 'string') {
            const tokenMatch = loginResponse.data.match(/access_token[=:][\s]*["']?([a-fA-F0-9]{72})["']?/);
            if (tokenMatch) {
              wialonToken = tokenMatch[1];
              console.log('✓ Token found in login.html response');
            }
          }
        } catch (loginError) {
          console.log('⚠ POST to login.html failed:', loginError.message);
        }
      }

      // Спосіб 3: Спробуємо симулювати відправку форми
      if (!wialonToken) {
        try {
          console.log('→ Trying form simulation...');
          
          // Спочатку отримуємо форму для витягування hidden полів
          const formResponse = await axios.get(
            `${wialonBaseUrl}/login.html?client_id=CustomApp&access_type=-1&activation_time=0&duration=3600&flags=1`,
            {
              headers: { 
                'User-Agent': 'Mozilla/5.0 (compatible; CustomApp/1.0)'
              },
              timeout: 10000
            }
          );

          // Шукаємо приховані поля в HTML
          let signValue = '';
          if (formResponse.data && typeof formResponse.data === 'string') {
            const signMatch = formResponse.data.match(/name="sign"[^>]*value="([^"]+)"/);
            if (signMatch) {
              signValue = signMatch[1];
              console.log('✓ Found sign value in form');
            }
          }

          // Відправляємо форму з усіма параметрами
          const formParams = {
            response_type: 'token',
            client_id: 'CustomApp',
            redirect_uri: `${wialonBaseUrl}/post_token.html`,
            access_type: -1,
            activation_time: 0,
            duration: 3600,
            flags: 1,
            sign: signValue,
            login: email,
            passw: password
          };

          const formSubmitResponse = await axios.post(
            `${wialonBaseUrl}/oauth.html`,
            new URLSearchParams(formParams).toString(),
            {
              headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (compatible; CustomApp/1.0)',
                'Referer': `${wialonBaseUrl}/login.html`
              },
              timeout: 15000,
              maxRedirects: 5,
              validateStatus: function (status) {
                return status >= 200 && status < 400;
              }
            }
          );

          console.log('← Form submit response status:', formSubmitResponse.status);
          
          if (formSubmitResponse.data && typeof formSubmitResponse.data === 'string') {
            const tokenMatch = formSubmitResponse.data.match(/access_token[=:][\s]*["']?([a-fA-F0-9]{72})["']?/);
            if (tokenMatch) {
              wialonToken = tokenMatch[1];
              console.log('✓ Token found in form submit response');
            }
          }
        } catch (formError) {
          console.log('⚠ Form simulation failed:', formError.message);
        }
      }

      if (!wialonToken) {
        console.log('✗ All Wialon authentication methods failed - invalid credentials');
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      console.log('✓ Wialon token received successfully');

      // Додатково перевіряємо токен через token/login API
      try {
        const tokenLoginResponse = await axios.post(
          `${tokenData.api_url}/wialon/ajax.html`,
          `svc=token/login&params=${encodeURIComponent(JSON.stringify({
            token: wialonToken,
            operateAs: ''
          }))}`,
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000
          }
        );

        console.log('← Token verification response:', tokenLoginResponse.status);
        
        if (tokenLoginResponse.data && tokenLoginResponse.data.error) {
          console.log('✗ Token verification failed:', tokenLoginResponse.data.error);
          return res.status(401).json({ message: 'Invalid credentials' });
        }

        console.log('✓ Wialon token verified successfully');
        console.log('✓ Wialon authentication successful');

      } catch (tokenVerifyError) {
        console.log('⚠ Token verification failed, but proceeding:', tokenVerifyError.message);
        // Продовжуємо, оскільки основний токен отримано
      }

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
            wialonToken.substring(0, 32), // перші 32 символи як session ID
            wialonToken,
            new Date(Date.now() + 3600 * 1000), // 1 година
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
          wialonToken: wialonToken,
          sessionId,
          permissions: ['customer_portal.read', 'tickets.read', 'tickets.create', 'chat.read', 'chat.create']
        },
        process.env.JWT_SECRET,
        { expiresIn: '1h' } // відповідає терміну дії Wialon токена
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

      console.log('✓ Client login successful with new Wialon method');
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
      console.log('✗ Wialon OAuth error:', wialonError.message);
      console.log('Error details:', {
        status: wialonError.response?.status,
        statusText: wialonError.response?.statusText,
        data: wialonError.response?.data
      });
      
      // Якщо це помилка авторизації (401, 403) - неправильні дані
      if (wialonError.response?.status === 401 || wialonError.response?.status === 403) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
      
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