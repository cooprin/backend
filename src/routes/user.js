const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const router = express.Router();

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(process.env.UPLOAD_DIR, 'avatars', req.user.userId.toString());
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `avatar-${uniqueSuffix}${path.extname(file.originalname)}`);
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

// Helper to remove old avatar
const removeOldAvatar = async (userId) => {
  try {
    const { rows } = await pool.query('SELECT avatar_url FROM users WHERE id = $1', [userId]);
    if (rows[0]?.avatar_url) {
      const oldAvatarPath = path.join(process.env.UPLOAD_DIR, rows[0].avatar_url);
      await fs.unlink(oldAvatarPath);
    }
  } catch (error) {
    console.error('Error removing old avatar:', error);
  }
};

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

    await removeOldAvatar(userId);

    await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2',
      [avatarUrl, userId]
    );

    res.json({ 
      success: true,
      avatar: `/uploads/${avatarUrl}`
    });
  } catch (error) {
    console.error('Error updating avatar:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error while updating avatar' 
    });
  }
});

// Profile update endpoint
router.put('/update-profile', authenticate, async (req, res) => {
  try {
    const { first_name, last_name } = req.body;
    const userId = req.user.userId;

    const { rows } = await pool.query(
      `UPDATE users 
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name)
       WHERE id = $3
       RETURNING id, email, first_name, last_name, avatar_url`,
      [first_name, last_name, userId]
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

// Password change endpoint
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
      'UPDATE users SET password = $1 WHERE id = $2',
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

module.exports = router;