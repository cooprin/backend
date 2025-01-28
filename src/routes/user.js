const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const router = express.Router();

// Existing multer configuration and middleware...
// (keeping all the existing code up to the routes)

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
      ? `WHERE first_name ILIKE $3 OR last_name ILIKE $3 OR email ILIKE $3`
      : '';
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) 
      FROM users 
      ${searchCondition}
    `;
    
    // Get users
    const usersQuery = `
      SELECT id, role_id, email, first_name, last_name, phone, 
             avatar_url, is_active, last_login, created_at, updated_at
      FROM users 
      ${searchCondition}
      ORDER BY ${sortBy} ${orderDirection}
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
      avatar_url: user.avatar_url ? `/uploads/${user.avatar_url}` : null
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
    
    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    const { rows } = await pool.query(
      `INSERT INTO users (email, password, role_id, first_name, last_name, phone, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
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
    
    const { rows } = await pool.query(
      `UPDATE users 
       SET email = $1, role_id = $2, first_name = $3, last_name = $4, 
           phone = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING id, email, role_id, first_name, last_name, phone, is_active, avatar_url`,
      [email, role_id, first_name, last_name, phone, is_active, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const userData = rows[0];
    if (userData.avatar_url) {
      userData.avatar_url = `/uploads/${userData.avatar_url}`;
    }
    
    res.json({
      success: true,
      user: userData
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating user'
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
       SET is_active = $1, updated_at = CURRENT_TIMESTAMP
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
    
    // Remove user's avatar if exists
    await removeOldAvatar(id);
    
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

// Get roles (needed for the role selection dropdown)
router.get('/roles', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM roles ORDER BY name');
    
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

// Keep existing routes (avatar upload, profile update, password change)...

module.exports = router;