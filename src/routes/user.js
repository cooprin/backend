const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const { AuditService, auditLogTypes } = require('../services/auditService');
const router = express.Router();
const authenticate = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');

// Налаштування multer для завантаження файлів
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(process.env.UPLOAD_DIR, 'avatars', req.user.userId);
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `avatar-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG and GIF are allowed'));
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter
});



// Get all users with pagination, sorting and search
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 10;
    const offset = (page - 1) * perPage;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'last_name';
    const descending = req.query.descending === 'true';
    
    const orderDirection = descending ? 'DESC' : 'ASC';
    
    // Build search condition
    const searchCondition = search 
      ? `WHERE users.first_name ILIKE $3 OR users.last_name ILIKE $3 OR users.email ILIKE $3`
      : '';
    
    // Get total count with search condition
    const countQuery = `
      SELECT COUNT(*) 
      FROM users 
      ${searchCondition}
    `;
    
    // Get users with roles
    const usersQuery = `
      SELECT 
        users.id,
        users.email,
        users.first_name,
        users.last_name,
        users.phone,
        users.avatar_url,
        users.is_active,
        users.last_login,
        users.created_at,
        users.updated_at,
        users.role_id,
        roles.name as role_name,
        roles.description as role_description
      FROM users
      LEFT JOIN roles ON users.role_id = roles.id
      ${searchCondition}
      ORDER BY users.${sortBy} ${orderDirection}
      LIMIT $1 OFFSET $2
    `;
    
    const params = [perPage, offset];
    if (search) {
      params.push(`%${search}%`);
    }
    
    const [countResult, usersResult] = await Promise.all([
      pool.query(countQuery, search ? [`%${search}%`] : []),
      pool.query(usersQuery, params)
    ]);
    
    const users = usersResult.rows.map(user => ({
      ...user,
      avatar_url: user.avatar_url ? `/uploads/avatars/${user.id}/${user.avatar_url}` : null
    }));
    
    // Додаємо логування перегляду списку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'LIST_VIEW',
      entityType: 'USER',
      ipAddress: req.ip,
      newValues: {
        page,
        perPage,
        search,
        sortBy,
        descending
      }
    });

    res.json({
      users,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while fetching users'
    });
  }
});

// Avatar upload endpoint
router.post('/avatar', authenticate, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No file uploaded' 
      });
    }

    const userId = req.user.userId;
    const avatarUrl = path.join('avatars', userId.toString(), req.file.filename);

    // Зберігаємо старий аватар для логування
    const oldUser = await pool.query('SELECT avatar_url FROM users WHERE id = $1', [userId]);
    const oldAvatarUrl = oldUser.rows[0]?.avatar_url;

    await pool.query(
      'UPDATE users SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [avatarUrl, userId]
    );

    // Логуємо зміну аватара
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'AVATAR_UPDATE',
      entityType: 'USER',
      entityId: userId,
      oldValues: { avatar_url: oldAvatarUrl },
      newValues: { avatar_url: avatarUrl },
      ipAddress: req.ip
    });

    res.json({ 
      success: true,
      avatar: `/uploads/${avatarUrl}`
    });
  } catch (error) {
    console.error('Error updating avatar:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      entityId: req.user.userId,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({ 
      success: false,
      message: 'Server error while updating avatar' 
    });
  }
});
// Profile update endpoint
router.put('/update-profile', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, phone } = req.body;
    const userId = req.user.userId;

    // Отримуємо старі дані для логування
    const oldUserData = await pool.query(
      'SELECT first_name, last_name, phone FROM users WHERE id = $1',
      [userId]
    );

    const { rows } = await pool.query(
      `UPDATE users 
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           phone = COALESCE($3, phone),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id, email, first_name, last_name, phone, avatar_url, role_id`,
      [first_name, last_name, phone, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    // Логуємо оновлення профілю
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PROFILE_UPDATE',
      entityType: 'USER',
      entityId: userId,
      oldValues: oldUserData.rows[0],
      newValues: { first_name, last_name, phone },
      ipAddress: req.ip
    });

    const userData = rows[0];
    if (userData.avatar_url) {
      userData.avatar_url = `/uploads/avatars/${userData.id}/${userData.avatar_url}`;
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: userData
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      entityId: req.user.userId,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({ 
      success: false,
      message: 'Server error while updating profile' 
    });
  }
});

// Change password endpoint
router.put('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user.userId;

    // Get current user's password hash
    const { rows } = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(current_password, rows[0].password);
    if (!isValidPassword) {
      // Логуємо невдалу спробу зміни пароля
      await AuditService.log({
        userId: req.user.userId,
        actionType: 'PASSWORD_CHANGE_FAILED',
        entityType: 'USER',
        entityId: userId,
        ipAddress: req.ip
      });
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(new_password, saltRounds);

    // Update password
    await pool.query(
      'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [hashedPassword, userId]
    );

    // Логуємо успішну зміну пароля
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'PASSWORD_CHANGE',
      entityType: 'USER',
      entityId: userId,
      ipAddress: req.ip
    });

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Error changing password:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      entityId: req.user.userId,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while changing password'
    });
  }
});

// Get roles
router.get('/roles', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, description FROM roles ORDER BY name'
    );
    
    // Логуємо перегляд ролей
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'VIEW_ROLES',
      entityType: 'ROLE',
      ipAddress: req.ip
    });

    res.json({
      success: true,
      roles: rows
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

// Create new user
router.post('/', authenticate, async (req, res) => {
  try {
    const { email, password, role_id, first_name, last_name, phone, is_active } = req.body;
    
    // Check if email already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists'
      });
    }
    
    // Check if role exists
    const roleExists = await pool.query('SELECT id FROM roles WHERE id = $1', [role_id]);
    if (roleExists.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role'
      });
    }
    
    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    const { rows } = await pool.query(
      `INSERT INTO users (
        email, password, role_id, first_name, last_name, 
        phone, is_active, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id, email, role_id, first_name, last_name, phone, is_active`,
      [email, hashedPassword, role_id, first_name, last_name, phone, is_active]
    );

    // Логуємо створення користувача
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'USER_CREATE',
      entityType: 'USER',
      entityId: rows[0].id,
      newValues: {
        email,
        role_id,
        first_name,
        last_name,
        phone,
        is_active
      },
      ipAddress: req.ip
    });
    
    res.status(201).json({
      success: true,
      user: rows[0]
    });
  } catch (error) {
    console.error('Error creating user:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while creating user'
    });
  }
});

// Update user
router.put('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role_id, first_name, last_name, phone, is_active } = req.body;
    
    // Отримуємо старі дані для логування
    const oldUserData = await pool.query(
      'SELECT email, role_id, first_name, last_name, phone, is_active FROM users WHERE id = $1',
      [id]
    );

    // Check if email already exists for other users
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2',
      [email, id]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists'
      });
    }
    
    // Check if role exists
    if (role_id) {
      const roleExists = await pool.query('SELECT id FROM roles WHERE id = $1', [role_id]);
      if (roleExists.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role'
        });
      }
    }
    
    const { rows } = await pool.query(
      `UPDATE users 
       SET email = $1,
           role_id = $2,
           first_name = $3,
           last_name = $4,
           phone = $5,
           is_active = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING id, email, role_id, first_name, last_name, phone, is_active`,
      [email, role_id, first_name, last_name, phone, is_active, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Логуємо оновлення користувача
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'USER_UPDATE',
      entityType: 'USER',
      entityId: id,
      oldValues: oldUserData.rows[0],
      newValues: {
        email,
        role_id,
        first_name,
        last_name,
        phone,
        is_active
      },
      ipAddress: req.ip
    });
    
    res.json({
      success: true,
      user: rows[0]
    });
  } catch (error) {
    console.error('Error updating user:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      entityId: req.params.id,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while updating user'
    });
  }
});

// Toggle user status
router.put('/:id/status', authenticate, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    // Отримуємо старий статус для логування
    const oldStatus = await pool.query(
      'SELECT is_active FROM users WHERE id = $1',
      [id]
    );
    
    const { rows } = await pool.query(
      `UPDATE users 
       SET is_active = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, is_active`,
      [is_active, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Логуємо зміну статусу
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'STATUS_CHANGE',
      entityType: 'USER',
      entityId: id,
      oldValues: { is_active: oldStatus.rows[0].is_active },
      newValues: { is_active },
      ipAddress: req.ip
    });
    
    res.json({
      success: true,
      user: rows[0]
    });
  } catch (error) {
    console.error('Error updating user status:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      entityId: req.params.id,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while updating user status'
    });
  }
});

// Delete user
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Отримуємо дані користувача перед видаленням для логування
    const userData = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    
    const { rows } = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Логуємо видалення користувача
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'USER_DELETE',
      entityType: 'USER',
      entityId: id,
      oldValues: userData.rows[0],
      ipAddress: req.ip
    });
    
    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    // Логуємо помилку
    await AuditService.log({
      userId: req.user.userId,
      actionType: 'ERROR',
      entityType: 'USER',
      entityId: req.params.id,
      ipAddress: req.ip,
      newValues: { error: error.message }
    });
    res.status(500).json({
      success: false,
      message: 'Server error while deleting user'
    });
  }
});

module.exports = router;