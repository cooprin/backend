const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');
const AuditService = require('../services/auditService');
const authenticate = require('../middleware/auth');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const axios = require('axios');

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
    const salt = await bcryptjs.genSalt(10);
    const hashedPassword = await bcryptjs.hash(password, salt);

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
      userType: 'staff',
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
          userType: 'staff',
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
          userType: 'staff',
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
        userType: 'staff',
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

    // Спробуємо отримати токен через правильну Wialon авторизацію
    try {
      console.log('→ Attempting new Wialon token-based authentication...');
      
      // Використовуємо правильний API URL
      const wialonApiUrl = tokenData.api_url; // https://hst-api.wialon.com
      const wialonHostingUrl = wialonApiUrl.replace('hst-api', 'hosting');
      
      console.log('Using Wialon API URL:', wialonApiUrl);
      console.log('Using Wialon Hosting URL:', wialonHostingUrl);

      let wialonToken = null;
      
      try {
        console.log('→ Getting authorization form to extract sign parameter...');
        
        // Спочатку отримуємо форму авторизації для витягування sign параметра
        const formResponse = await axios.get(
          `${wialonHostingUrl}/login.html?client_id=wialon&access_type=-1&activation_time=0&duration=2592000&flags=6`,
          {
            headers: { 
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0'
            },
            timeout: 10000
          }
        );

        console.log('← Form response status:', formResponse.status);

        // Витягуємо sign параметр з HTML форми
        let signValue = '';
        if (formResponse.data && typeof formResponse.data === 'string') {
          const signMatch = formResponse.data.match(/name="sign"[^>]*value="([^"]+)"/);
          if (signMatch) {
            signValue = signMatch[1];
            console.log('✓ Found sign value:', signValue.substring(0, 20) + '...');
          } else {
            console.log('⚠ Sign parameter not found in form');
          }
        }

        if (!signValue) {
          throw new Error('Could not extract sign parameter from authorization form');
        }

        console.log('→ Sending POST to oauth/authorize.html...');

        // Тепер відправляємо POST запит з правильними параметрами
        const authParams = {
          response_type: 'token',
          wialon_sdk_url: wialonApiUrl,
          success_uri: '',
          login_uri: `${wialonHostingUrl}/login.html`,
          client_id: 'wialon',
          redirect_uri: `${wialonHostingUrl}/login.html`,
          access_type: -1,
          activation_time: 0,
          duration: 2592000, // 30 днів
          flags: 6,
          sign: signValue,
          login: email,
          passw: password
        };

        console.log('POST parameters:', {
          ...authParams,
          passw: '[HIDDEN]',
          sign: signValue.substring(0, 20) + '...'
        });

        const authResponse = await axios.post(
          `${wialonApiUrl}/oauth/authorize.html`,
          new URLSearchParams(authParams).toString(),
          {
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0',
              'Referer': `${wialonHostingUrl}/login.html`
            },
            timeout: 15000,
            maxRedirects: 10, // слідкуємо за редиректами
            validateStatus: function (status) {
              return status >= 200 && status < 400;
            }
          }
        );

        console.log('← Auth response status:', authResponse.status);
        console.log('← Auth response URL:', authResponse.request?.res?.responseUrl || 'N/A');

        // Шукаємо токен в URL відповіді (після редиректів)
        if (authResponse.request?.res?.responseUrl) {
          try {
            const responseUrl = new URL(authResponse.request.res.responseUrl);
            const tokenFromUrl = responseUrl.searchParams.get('access_token');
            if (tokenFromUrl) {
              wialonToken = tokenFromUrl;
              console.log('✓ Token found in response URL');
            }
          } catch (e) {
            console.log('⚠ Error parsing response URL:', e.message);
          }
        }

        // Якщо токен не знайдено - логуємо для відстеження
        if (!wialonToken) {
          console.log('✗ No token found in response');
          console.log('Response preview:', authResponse.data?.substring(0, 500));
          console.log('Available URL sources:', {
            responseURL: authResponse.request?.responseURL,
            'res.responseUrl': authResponse.request?.res?.responseUrl,
            path: authResponse.request?.path,
            location: authResponse.headers?.location
          });
        }

        if (!wialonToken) {
          console.log('✗ No token found in response');
          console.log('Response preview:', authResponse.data?.substring(0, 1000));
          console.log('Full response length:', authResponse.data?.length);
          
          // Перевіряємо чи є в відповіді повідомлення про помилку
          if (authResponse.data && typeof authResponse.data === 'string') {
            if (authResponse.data.includes('error') || authResponse.data.includes('Error')) {
              console.log('⚠ Error indicators found in response');
            }
            if (authResponse.data.includes('login') || authResponse.data.includes('password')) {
              console.log('⚠ Login form detected - possibly invalid credentials');
            }
            if (authResponse.data.includes('access_token')) {
              console.log('⚠ Access token mentioned but not extracted properly');
            }
          }
        }

      } catch (authError) {
        console.log('✗ Wialon authorization failed:', authError.message);
        console.log('Authorization error details:', {
          status: authError.response?.status,
          statusText: authError.response?.statusText,
          headers: authError.response?.headers,
          url: authError.config?.url,
          data: typeof authError.response?.data === 'string' 
            ? authError.response.data.substring(0, 500)
            : authError.response?.data
        });
        
        // Якщо це помилка авторизації (401, 403) - неправильні дані
        if (authError.response?.status === 401 || authError.response?.status === 403) {
          // Логування невдалого входу клієнта
          await AuditService.log({
            clientId: client.id,
            userType: 'client',
            actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.LOGIN_FAILED,
            entityType: ENTITY_TYPES.CLIENT,
            entityId: client.id,
            newValues: { 
              client_id: client.id, 
              wialon_username: email,
              reason: 'Invalid Wialon credentials'
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
          });
          return res.status(401).json({ message: 'Invalid credentials' });
        }
        
        // Для інших помилок - пробуємо далі або повертаємо помилку сервісу
        throw authError;
      }

      if (!wialonToken) {
        console.log('✗ No Wialon token received - invalid credentials or service error');
        // Логування невдалого входу клієнта
        await AuditService.log({
          clientId: client.id,
          userType: 'client',
          actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.LOGIN_FAILED,
          entityType: ENTITY_TYPES.CLIENT,
          entityId: client.id,
          newValues: { 
            client_id: client.id, 
            wialon_username: email,
            reason: 'No Wialon token received'
          },
          ipAddress: req.ip,
          auditType: AUDIT_TYPES.BUSINESS,
          req
        });
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
          // Логування невдалого входу клієнта
          await AuditService.log({
            clientId: client.id,
            userType: 'client',
            actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.LOGIN_FAILED,
            entityType: ENTITY_TYPES.CLIENT,
            entityId: client.id,
            newValues: { 
              client_id: client.id, 
              wialon_username: email,
              reason: 'Token verification failed'
            },
            ipAddress: req.ip,
            auditType: AUDIT_TYPES.BUSINESS,
            req
          });
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
            new Date(Date.now() + 2592000 * 1000), // 30 днів
            req.ip,
            req.headers['user-agent']
          ]
        );
        sessionId = sessionResult.rows[0].id;
        console.log('✓ Client session created:', sessionId);
        
        // Логування створення сесії
        await AuditService.log({
          clientId: client.id,
          userType: 'client',
          actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.SESSION_START,
          entityType: ENTITY_TYPES.CLIENT_SESSION,
          entityId: sessionId,
          newValues: { 
            client_id: client.id,
            session_id: sessionId,
            wialon_username: client.wialon_username
          },
          ipAddress: req.ip,
          auditType: AUDIT_TYPES.BUSINESS,
          req
        });
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
        { expiresIn: '30d' } // відповідає терміну дії Wialon токена
      );

      // Логування успішного входу клієнта
      await AuditService.log({
        clientId: client.id,
        userType: 'client',
        actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.LOGIN,
        entityType: ENTITY_TYPES.CLIENT,
        entityId: client.id,
        newValues: { 
          client_id: client.id, 
          wialon_username: email,
          client_name: client.name 
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