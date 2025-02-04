const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const bcrypt = require('bcrypt');
const { AuditService } = require('../services/auditService');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');

// Validate password strength
function validatePassword(password) {
  if (!password || password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long' };
  }
  
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  
  if (!hasUpperCase || !hasLowerCase || !hasNumbers || !hasSpecialChar) {
    return {
      valid: false,
      message: 'Password must contain uppercase and lowercase letters, numbers, and special characters'
    };
  }
  
  return { valid: true };
}

// Get all users
router.get('/', authenticate, checkPermission('users.read'), async (req, res) => {
  try {
    let { 
      page = 1, 
      perPage = 10,
      sortBy = 'last_name',
      descending = false,
      search = '',
      roleId
    } = req.query;

    if (perPage === 'All') {
      perPage = null;
    } else {
      perPage = parseInt(perPage);
      page = parseInt(page);
    }
    
    const offset = perPage ? (page - 1) * perPage : 0;
    const orderDirection = descending === 'true' ? 'DESC' : 'ASC';

    // Validate sortBy to prevent SQL injection
    const allowedSortColumns = ['first_name', 'last_name', 'email', 'created_at', 'updated_at'];
    if (!allowedSortColumns.includes(sortBy)) {
      sortBy = 'last_name';
    }

    let conditions = [];
    let params = []; 
    let paramIndex = 1;

    if (search) {
      conditions.push(`(
        u.first_name ILIKE $${paramIndex} OR 
        u.last_name ILIKE $${paramIndex} OR 
        u.email ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (roleId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM user_roles ur 
        WHERE ur.user_id = u.id 
        AND ur.role_id = $${paramIndex}
      )`);
      params.push(roleId);
      paramIndex++;
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const usersQuery = `
      SELECT 
        u.*,
        array_remove(array_agg(DISTINCT r.name), null) as roles,
        array_remove(array_agg(DISTINCT r.id), null) as role_ids
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY u.${sortBy} ${orderDirection}
      ${perPage ? `LIMIT $${paramIndex} OFFSET $${paramIndex + 1}` : ''}
    `;

    const countQuery = `
      SELECT COUNT(DISTINCT u.id)
      FROM users u
      ${whereClause}
    `;

    if (perPage) {
      params.push(perPage, offset);
    }

    const [countResult, usersResult] = await Promise.all([
      pool.query(countQuery, params),
      pool.query(usersQuery, params)
    ]);

    const users = usersResult.rows.map(user => ({
      ...user,
      password: undefined,
      roles: user.roles || [],
      role_ids: user.role_ids || []
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

// Get roles for user management
router.get('/roles', authenticate, checkPermission('users.read'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, description
      FROM roles 
      ORDER BY name
    `);
    
    res.json({
      success: true,
      roles: result.rows
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

    const { 
      email, 
      password, 
      first_name, 
      last_name, 
      phone, 
      is_active = true, 
      role_ids 
    } = req.body;

    // Validate required fields
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, first name and last name are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message
      });
    }

    // Check if email exists
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

    // Validate roles if provided
    if (role_ids && role_ids.length > 0) {
      const rolesExist = await client.query(
        'SELECT COUNT(*) FROM roles WHERE id = ANY($1)',
        [role_ids]
      );
      
      if (rolesExist.rows[0].count !== role_ids.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Some roles do not exist'
        });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    const userResult = await client.query(
      `INSERT INTO users (
        email, password, first_name, last_name, phone, is_active, 
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [email, hashedPassword, first_name, last_name, phone, is_active]
    );

    // Assign roles
    if (role_ids && role_ids.length > 0) {
      const roleValues = role_ids.map(roleId => 
        `('${userResult.rows[0].id}', '${roleId}')`
      ).join(',');

      await client.query(`
        INSERT INTO user_roles (user_id, role_id)
        VALUES ${roleValues}
      `);
    }

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'USER_CREATE',
      entityType: 'USER',
      entityId: userResult.rows[0].id,
      newValues: { 
        email, 
        first_name, 
        last_name, 
        phone, 
        is_active, 
        role_ids 
      },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    // Get user with roles
    const user = await pool.query(`
      SELECT 
        u.*,
        array_remove(array_agg(DISTINCT r.name), null) as roles,
        array_remove(array_agg(DISTINCT r.id), null) as role_ids
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.id = $1
      GROUP BY u.id
    `, [userResult.rows[0].id]);

    const userData = {
      ...user.rows[0],
      password: undefined,
      roles: user.rows[0].roles || [],
      role_ids: user.rows[0].role_ids || []
    };

    res.status(201).json({
      success: true,
      user: userData
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
    const { id } = req.params;
    const { 
      email, 
      first_name, 
      last_name, 
      phone, 
      role_ids, 
      is_active 
    } = req.body;

    await client.query('BEGIN');

    // Get current user data
    const oldUserData = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );

    if (oldUserData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check email uniqueness if changing
    if (email && email !== oldUserData.rows[0].email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      const existingUser = await client.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, id]
      );
      
      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Email already exists'
        });
      }
    }

    // Validate roles if provided
    if (role_ids && role_ids.length > 0) {
      const rolesExist = await client.query(
        'SELECT COUNT(*) FROM roles WHERE id = ANY($1)',
        [role_ids]
      );
      
      if (rolesExist.rows[0].count !== role_ids.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Some roles do not exist'
        });
      }
    }

    // Prevent self-deactivation
    if (id === req.user.userId && is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own account'
      });
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
      [email, first_name, last_name, phone, is_active, id]
    );

    // Update roles if provided
    if (role_ids) {
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      
      if (role_ids.length > 0) {
        const roleValues = role_ids.map(roleId => 
          `('${id}', '${roleId}')`
        ).join(',');

        await client.query(`
          INSERT INTO user_roles (user_id, role_id)
          VALUES ${roleValues}
        `);
      }
    }

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'USER_UPDATE',
      entityType: 'USER',
      entityId: id,
      oldValues: {
        email: oldUserData.rows[0].email,
        first_name: oldUserData.rows[0].first_name,
        last_name: oldUserData.rows[0].last_name,
        phone: oldUserData.rows[0].phone,
        is_active: oldUserData.rows[0].is_active
      },
      newValues: { 
        email, 
        first_name, 
        last_name, 
        phone, 
        role_ids, 
        is_active 
      },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    // Get updated user with roles
    const user = await pool.query(`
      SELECT 
        u.*,
        array_remove(array_agg(DISTINCT r.name), null) as roles,
        array_remove(array_agg(DISTINCT r.id), null) as role_ids
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.id = $1
      GROUP BY u.id
    `, [id]);

    const userData = {
      ...user.rows[0],
      password: undefined,
      roles: user.rows[0].roles || [],
      role_ids: user.rows[0].role_ids || []
    };

    res.json({
      success: true,
      user: userData
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

    // Check for self-deletion
    if (id === req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    // Get user data for audit
    const userData = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );

    if (userData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check for audit records
    const auditRecords = await client.query(
      'SELECT COUNT(*) FROM audit_logs WHERE user_id = $1',
      [id]
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

    // Delete all user data
    if (force) {
      await client.query(
        'UPDATE audit_logs SET user_id = NULL WHERE user_id = $1',
        [id]
      );
    }

    // Delete user roles
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);

    // Delete user
    await client.query('DELETE FROM users WHERE id = $1', [id]);

    await AuditService.log({
      userId: req.user.userId,
      actionType: force ? 'USER_DELETE_WITH_AUDIT' : 'USER_DELETE',
      entityType: 'USER',
      entityId: id,
      oldValues: userData.rows[0],
      ipAddress: req.ip,
      details: force ? `Deleted with ${auditRecords.rows[0].count} audit records` : null
    });

    await client.query('COMMIT');
   
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
    
    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message
      });
    }

    // Get user data for check
    const userData = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );

    if (userData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Update password
    await client.query(
      `UPDATE users 
       SET password = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [hashedPassword, id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: 'USER_PASSWORD_CHANGE',
      entityType: 'USER',
      entityId: id,
      newValues: { password: '[REDACTED]' },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

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

// Toggle user status
router.put('/:id/status', authenticate, checkPermission('users.update'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { is_active } = req.body;

    // Prevent self-deactivation
    if (id === req.user.userId && !is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own account'
      });
    }
    
    // Get user data for check
    const userData = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );

    if (userData.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user status
    const userResult = await client.query(
      `UPDATE users 
       SET is_active = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [is_active, id]
    );

    await AuditService.log({
      userId: req.user.userId,
      actionType: is_active ? 'USER_ACTIVATE' : 'USER_DEACTIVATE',
      entityType: 'USER',
      entityId: id,
      oldValues: { is_active: userData.rows[0].is_active },
      newValues: { is_active },
      ipAddress: req.ip
    });

    await client.query('COMMIT');

    res.json({
      success: true,
      user: {
        ...userResult.rows[0],
        password: undefined
      }
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