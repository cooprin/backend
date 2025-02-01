const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const { AuditService } = require('../services/auditService');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { checkPermission, checkMultiplePermissions } = require('../middleware/checkPermission');


// Налаштування multer
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

// Get all users
router.get('/', authenticate, checkPermission('users.read'), async (req, res) => {
 try {
   const page = parseInt(req.query.page) || 1;
   const perPage = parseInt(req.query.perPage) || 10;
   const offset = (page - 1) * perPage;
   const search = req.query.search || '';
   const sortBy = req.query.sortBy || 'last_name';
   const descending = req.query.descending === 'true';
   
   const orderDirection = descending ? 'DESC' : 'ASC';
   
   const searchCondition = search 
     ? `WHERE u.first_name ILIKE $3 OR u.last_name ILIKE $3 OR u.email ILIKE $3`
     : '';
   
   const usersQuery = `
     SELECT 
       u.*,
       array_agg(DISTINCT r.name) as roles,
       (SELECT name FROM roles r2 
        JOIN user_roles ur2 ON r2.id = ur2.role_id 
        WHERE ur2.user_id = u.id 
        LIMIT 1) as role_name
     FROM users u
     LEFT JOIN user_roles ur ON u.id = ur.user_id
     LEFT JOIN roles r ON ur.role_id = r.id
     ${searchCondition}
     GROUP BY u.id
     ORDER BY u.${sortBy} ${orderDirection}
     LIMIT $1 OFFSET $2
   `;
   
   const countQuery = `
     SELECT COUNT(*) 
     FROM users u
     ${searchCondition}
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
     avatar_url: user.avatar_url ? `/uploads/avatars/${user.id}/${user.avatar_url}` : null,
     roles: user.roles.filter(Boolean)
   }));
   
   res.json({
     users,
     total: parseInt(countResult.rows[0].count)
   });
 } catch (error) {
   console.error('Error fetching users:', error);
   res.status(500).json({
     success: false,
     message: 'Server error while fetching users'
   });
 }
});

// Get roles
router.get('/roles', authenticate, async (req, res) => {
 try {
   const { rows } = await pool.query(
     'SELECT id, name, description FROM roles ORDER BY name'
   );
   
   res.json({
     success: true,
     roles: rows
   });
 } catch (error) {
   console.error('Error fetching roles:', error);
   res.status(500).json({
     success: false,
     message: 'Server error while fetching roles'
   });
 }
});

// Create user
router.post('/', authenticate, checkPermission('users.create'), async (req, res) => {
 const client = await pool.connect();
 try {
   await client.query('BEGIN');

   const { email, password, firstName, lastName, phone, role_id } = req.body;
   
   const existingUser = await client.query(
     'SELECT id FROM users WHERE email = $1',
     [email]
   );
   
   if (existingUser.rows.length > 0) {
     return res.status(400).json({
       success: false,
       message: 'Email already exists'
     });
   }

   const salt = await bcrypt.genSalt(10);
   const hashedPassword = await bcrypt.hash(password, salt);
   
   const userResult = await client.query(
     `INSERT INTO users (
       email, password, first_name, last_name, phone, is_active, 
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING *`,
     [email, hashedPassword, firstName, lastName, phone]
   );

   // Додаємо роль
   if (role_id) {
     await client.query(
       `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
       [userResult.rows[0].id, role_id]
     );
   }

   await client.query('COMMIT');

   await AuditService.log({
     userId: req.user.userId,
     actionType: 'USER_CREATE',
     entityType: 'USER',
     entityId: userResult.rows[0].id,
     newValues: { email, firstName, lastName, phone, role_id },
     ipAddress: req.ip
   });

   res.status(201).json({
     success: true,
     user: userResult.rows[0]
   });
 } catch (error) {
   await client.query('ROLLBACK');
   console.error('Error creating user:', error);
   res.status(500).json({
     success: false,
     message: 'Server error while creating user'
   });
 } finally {
   client.release();
 }
});

// Update user
router.put('/:id', authenticate, checkPermission('users.update'), async (req, res) => {
 const client = await pool.connect();
 try {
   await client.query('BEGIN');

   const { id } = req.params;
   const { email, firstName, lastName, phone, role_id, is_active } = req.body;
   
   const oldUserData = await client.query(
     'SELECT * FROM users WHERE id = $1',
     [id]
   );

   if (email) {
     const existingUser = await client.query(
       'SELECT id FROM users WHERE email = $1 AND id != $2',
       [email, id]
     );
     if (existingUser.rows.length > 0) {
       return res.status(400).json({
         success: false,
         message: 'Email already exists'
       });
     }
   }

   const userResult = await client.query(
     `UPDATE users 
      SET email = COALESCE($1, email),
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          phone = COALESCE($4, phone),
          is_active = COALESCE($5, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *`,
     [email, firstName, lastName, phone, is_active, id]
   );

   if (userResult.rows.length === 0) {
     await client.query('ROLLBACK');
     return res.status(404).json({
       success: false,
       message: 'User not found'
     });
   }

   // Оновлюємо роль
   if (role_id) {
     await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
     await client.query(
       'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
       [id, role_id]
     );
   }

   await client.query('COMMIT');

   await AuditService.log({
     userId: req.user.userId,
     actionType: 'USER_UPDATE',
     entityType: 'USER',
     entityId: id,
     oldValues: oldUserData.rows[0],
     newValues: { email, firstName, lastName, phone, role_id, is_active },
     ipAddress: req.ip
   });

   // Отримуємо оновлені дані користувача з роллю
   const updatedUser = await pool.query(`
     SELECT u.*, r.name as role_name
     FROM users u
     LEFT JOIN user_roles ur ON u.id = ur.user_id
     LEFT JOIN roles r ON ur.role_id = r.id
     WHERE u.id = $1
   `, [id]);

   res.json({
     success: true,
     user: updatedUser.rows[0]
   });
 } catch (error) {
   await client.query('ROLLBACK');
   console.error('Error updating user:', error);
   res.status(500).json({
     success: false,
     message: 'Server error while updating user'
   });
 } finally {
   client.release();
 }
});

// Delete user
router.delete('/:id', authenticate, checkPermission('users.delete'), async (req, res) => {
 try {
   const { id } = req.params;

   if (id === req.user.userId) {
     return res.status(400).json({
       success: false,
       message: 'Cannot delete your own account'
     });
   }

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
   res.status(500).json({
     success: false,
     message: 'Server error while deleting user'
   });
 }
});

// Avatar upload
router.post('/avatar', authenticate, upload.single('avatar'), async (req, res) => {
 try {
   if (!req.file) {
     return res.status(400).json({ 
       success: false,
       message: 'No file uploaded' 
     });
   }

   const avatarUrl = path.relative(process.env.UPLOAD_DIR, req.file.path);
   
   const oldUser = await pool.query(
     'SELECT avatar_url FROM users WHERE id = $1',
     [req.user.userId]
   );

   await pool.query(
     'UPDATE users SET avatar_url = $1 WHERE id = $2',
     [avatarUrl, req.user.userId]
   );

   await AuditService.log({
     userId: req.user.userId,
     actionType: 'AVATAR_UPDATE',
     entityType: 'USER',
     entityId: req.user.userId,
     oldValues: { avatar_url: oldUser.rows[0]?.avatar_url },
     newValues: { avatar_url: avatarUrl },
     ipAddress: req.ip
   });

   res.json({ 
     success: true,
     avatar: `/uploads/${avatarUrl}`
   });
 } catch (error) {
   console.error('Error uploading avatar:', error);
   res.status(500).json({ 
     success: false,
     message: 'Server error while uploading avatar' 
   });
 }
});

module.exports = router;