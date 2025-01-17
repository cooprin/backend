const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Налаштування для multer
const uploadDir = process.env.UPLOAD_DIR || 'uploads';
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Middleware для перевірки токену
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Оновлення профілю
router.put('/update-profile', authenticate, upload.single('avatar'), async (req, res) => {
  try {
    const { firstName, lastName, phone } = req.body;
    const userId = req.user.userId;
    let avatarUrl = null;

    // Якщо є завантажений файл, оновлюємо URL аватара
    if (req.file) {
      avatarUrl = path.join('/uploads', req.file.filename);

      // Видалення старого аватара, якщо він існує
      const oldAvatar = await pool.query(
        'SELECT avatar_url FROM users WHERE id = $1',
        [userId]
      );

      if (oldAvatar.rows[0]?.avatar_url) {
        const oldAvatarPath = path.join(uploadDir, path.basename(oldAvatar.rows[0].avatar_url));
        if (fs.existsSync(oldAvatarPath)) {
          fs.unlinkSync(oldAvatarPath);
        }
      }
    }

    // Оновлення даних користувача
    await pool.query(
      `UPDATE users 
       SET first_name = $1, last_name = $2, phone = $3, avatar_url = COALESCE($4, avatar_url)
       WHERE id = $5`,
      [firstName, lastName, phone, avatarUrl, userId]
    );

    // Отримуємо оновлені дані користувача
    const updatedUser = await pool.query(
      `SELECT id, email, first_name, last_name, phone, avatar_url 
       FROM users WHERE id = $1`,
      [userId]
    );

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
