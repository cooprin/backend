const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const router = express.Router();

// Authentication middleware
const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token is missing' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Get all users with pagination, sorting and search
router.get('/', authenticate, async (req, res) => {
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
// Profile update endpoint (відсутній)
router.put('/update-profile', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, phone } = req.body;
    const userId = req.user.userId;

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
    res.status(500).json({ 
      success: false,
      message: 'Server error while updating profile' 
    });
  }
});

// Change password endpoint (відсутній)
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

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Error changing password:', error);
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
    
    res.status(201).json({
      success: true,
      user: rows[0]
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating user'
    });
  }
});

// Update user
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role_id, first_name, last_name, phone, is_active } = req.body;
    
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
    
    res.json({
      success: true,
      user: rows[0]
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating user'
    });
  }
});

// Change password
router.put('/:id/password', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    const { rows } = await pool.query(
      `UPDATE users 
       SET password = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id`,
      [hashedPassword, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating password'
    });
  }
});

// Toggle user status
router.put('/:id/status', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    
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
    
    res.json({
      success: true,
      user: rows[0]
    });
  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating user status'
    });
  }
});

// Delete user
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
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

module.exports = router;