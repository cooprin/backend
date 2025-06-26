const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const path = require('path');
const fs = require('fs').promises;
const bcryptjs = require('bcryptjs');
const AuditService = require('../services/auditService');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { checkPermission, checkMultiplePermissions } = require('../middleware/checkPermission');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');


// Get all users
router.get('/', authenticate, checkPermission('users.read'), async (req, res) => {
  try {
    let { 
      page = 1, 
      perPage = 10, 
      search = '',
      sortBy = 'last_name',
      descending = false 
    } = req.query;

    if (perPage === 'All') {
      perPage = null;
    } else {
      perPage = parseInt(perPage);
      page = parseInt(page);
    }
    
    const offset = perPage ? (page - 1) * perPage : 0;
    const orderDirection = descending === 'true' ? 'DESC' : 'ASC';
    
    let params = [];
    let paramIndex = 1;
    
    const searchCondition = search 
      ? `WHERE u.first_name ILIKE $${paramIndex} OR u.last_name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex}`
      : '';

    if (search) {
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    let usersQuery = `
      SELECT 
        u.*,
        array_agg(DISTINCT r.name) as roles,
        (SELECT name FROM auth.roles r2 
         JOIN auth.user_roles ur2 ON r2.id = ur2.role_id 
         WHERE ur2.user_id = u.id 
         LIMIT 1) as role_name
      FROM auth.users u
      LEFT JOIN auth.user_roles ur ON u.id = ur.user_id
      LEFT JOIN auth.roles r ON ur.role_id = r.id
      ${searchCondition}
      GROUP BY u.id
      ORDER BY u.${sortBy} ${orderDirection}
    `;
    
    if (perPage) {
      usersQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(perPage, offset);
    }
    
    const countQuery = `
      SELECT COUNT(*) 
      FROM auth.users u
      ${searchCondition}
    `;
    
    const [countResult, usersResult] = await Promise.all([
      pool.query(countQuery, search ? params.slice(0, 1) : []),
      pool.query(usersQuery, params)
    ]);
    
    const users = usersResult.rows.map(user => ({
      ...user,
      avatar_url: user.avatar_url ? `/uploads/avatars/${user.id}/${user.avatar_url}` : null,
      roles: user.roles.filter(Boolean)
    }));
    
    res.json({
      success: true,
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
     'SELECT id, name, description FROM auth.roles ORDER BY name'
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

   const { email, password, first_name, last_name, phone, is_active, role_id } = req.body;
   
   const existingUser = await client.query(
     'SELECT id FROM auth.users WHERE email = $1',
     [email]
   );
   
   if (existingUser.rows.length > 0) {
     return res.status(400).json({
       success: false,
       message: 'Email already exists'
     });
   }

   const salt = await bcryptjs.genSalt(10);
   const hashedPassword = await bcryptjs.hash(password, salt);
   
   const userResult = await client.query(
     `INSERT INTO auth.users (
       email, password, first_name, last_name, phone, is_active, 
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING *`,
     [email, hashedPassword, first_name, last_name, phone, is_active]
   );

   // Додаємо роль
   if (role_id) {
     await client.query(
       `INSERT INTO auth.user_roles (user_id, role_id) VALUES ($1, $2)`,
       [userResult.rows[0].id, role_id]
     );
   }

   await client.query('COMMIT');

   await AuditService.log({
    userId: req.user.userId,
    actionType: AUDIT_LOG_TYPES.USER.CREATE,
    entityType: ENTITY_TYPES.USER,
    entityId: userResult.rows[0].id,
    newValues: { email, first_name, last_name, phone, is_active, role_id },
    ipAddress: req.ip,
    auditType: AUDIT_TYPES.BUSINESS,
    req
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
   const { email, first_name, last_name, phone, role_id, is_active } = req.body;
   
   const oldUserData = await client.query(
     'SELECT * FROM auth.users WHERE id = $1',
     [id]
   );

   if (email) {
     const existingUser = await client.query(
       'SELECT id FROM auth.users WHERE email = $1 AND id != $2',
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
     `UPDATE auth.users 
      SET email = COALESCE($1, email),
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          phone = COALESCE($4, phone),
          is_active = COALESCE($5, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *`,
     [email, first_name, last_name, phone, is_active, id]
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
     await client.query('DELETE FROM auth.user_roles WHERE user_id = $1', [id]);
     await client.query(
       'INSERT INTO auth.user_roles (user_id, role_id) VALUES ($1, $2)',
       [id, role_id]
     );
   }

   await client.query('COMMIT');

   await AuditService.log({
    userId: req.user.userId,
    actionType: AUDIT_LOG_TYPES.USER.UPDATE,
    entityType: ENTITY_TYPES.USER,
    entityId: id,
    oldValues: oldUserData.rows[0],
    newValues: { email, first_name, last_name, phone, role_id, is_active },
    ipAddress: req.ip,
    auditType: AUDIT_TYPES.BUSINESS,
    req
  });

   // Отримуємо оновлені дані користувача з роллю
   const updatedUser = await pool.query(`
     SELECT u.*, r.name as role_name
     FROM auth.users u
     LEFT JOIN auth.user_roles ur ON u.id = ur.user_id
     LEFT JOIN auth.roles r ON ur.role_id = r.id
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { force } = req.query;

    // Перевірка на видалення власного акаунту
    if (id === req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    // Отримуємо дані користувача для аудиту
    const userData = await client.query(
      'SELECT * FROM auth.users WHERE id = $1',
      [id]
    );

    if (userData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Перевіряємо наявність записів в аудиті
    const auditRecords = await client.query(
      'SELECT COUNT(*) FROM audit.audit_logs WHERE entity_type = $1 AND entity_id = $2',
      ['USER', id]
    );

    if (auditRecords.rows[0].count > 0 && !force) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'User has audit records',
        hasAuditRecords: true,
        recordsCount: parseInt(auditRecords.rows[0].count)
      });
    }

    // Якщо force=true або немає записів аудиту, видаляємо все
    if (force) {
      // Видаляємо записи аудиту для цього користувача
      await client.query(
        'DELETE FROM audit.audit_logs WHERE entity_type = $1 AND entity_id = $2',
        ['USER', id]
      );
      
      // Видаляємо записи аудиту, де цей користувач був ініціатором
      await client.query(
        'DELETE FROM audit.audit_logs WHERE user_id = $1',
        [id]
      );
    }

    // Видаляємо зв'язки з ролями
    await client.query(
      'DELETE FROM  auth.user_roles WHERE user_id = $1',
      [id]
    );

    // Видаляємо користувача
    const { rows } = await client.query(
      'DELETE FROM  auth.users WHERE id = $1 RETURNING id',
      [id]
    );

    await client.query('COMMIT');

    // Логуємо видалення в аудит
    await AuditService.log({
      userId: req.user.userId,
      actionType: force ? AUDIT_LOG_TYPES.USER.DELETE_WITH_AUDIT : AUDIT_LOG_TYPES.USER.DELETE,
      entityType: ENTITY_TYPES.USER,
      entityId: id,
      oldValues: userData.rows[0],
      ipAddress: req.ip,
      details: force ? `Deleted with ${auditRecords.rows[0].count} audit records` : null,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });
   
    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting user'
    });
  } finally {
    client.release();
  }
});
// Change password
router.put('/:id/password', authenticate, checkPermission('users.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { password } = req.body;
    
    // Get old user data for audit
    const oldUserData = await client.query(
      'SELECT * FROM  auth.users WHERE id = $1',
      [id]
    );

    if (oldUserData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Hash new password
    const salt = await bcryptjs.genSalt(10);
    const hashedPassword = await bcryptjs.hash(password, salt);
    
    // Update password
    await client.query(
      `UPDATE  auth.users 
       SET password = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [hashedPassword, id]
    );

    await client.query('COMMIT');

    // Log password change in audit
    await AuditService.log({
      userId: req.user.userId,
      actionType: AUDIT_LOG_TYPES.USER.PASSWORD_CHANGE,  // Змінюємо на коректну константу
      entityType: ENTITY_TYPES.USER,
      entityId: id,
      oldValues: { password: '[REDACTED]' },
      newValues: { password: '[REDACTED]' },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating password:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating password'
    });
  } finally {
    client.release();
  }
});

// Toggle user status (activate/deactivate)
router.put('/:id/status', authenticate, checkPermission('users.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { is_active } = req.body;

    // Prevent self-deactivation
    if (id === req.user.userId && !is_active) {
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own account'
      });
    }
    
    // Get old user data for audit
    const oldUserData = await client.query(
      'SELECT * FROM  auth.users WHERE id = $1',
      [id]
    );

    if (oldUserData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user status
    const userResult = await client.query(
      `UPDATE  auth.users 
       SET is_active = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [is_active, id]
    );

    await client.query('COMMIT');

    // Log status change in audit
    await AuditService.log({
      userId: req.user.userId,
      actionType: is_active ? AUDIT_LOG_TYPES.USER.ACTIVATE : AUDIT_LOG_TYPES.USER.DEACTIVATE,
      entityType: ENTITY_TYPES.USER,
      entityId: id,
      oldValues: { is_active: oldUserData.rows[0].is_active },
      newValues: { is_active },
      ipAddress: req.ip,
      auditType: AUDIT_TYPES.BUSINESS,
      req
    });

    res.json({
      success: true,
      user: userResult.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating user status:', error);
    res.status(500).json({
      success: false, 
      message: 'Server error while updating user status'
    });
  } finally {
    client.release();
  }
});



module.exports = router;