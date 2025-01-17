const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Налаштування для multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, process.env.UPLOAD_DIR)
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      cb(null, `avatar-${uniqueSuffix}${path.extname(file.originalname)}`)
    }
  });

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB ліміт
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Дозволені лише зображення'))
    }
  }
});

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

router.put('/update-avatar', upload.single('avatar'), async (req, res) => {
    try {
      const filePath = `/uploads/${req.file.filename}` // шлях для доступу до файлу
      
      // Оновіть поле avatar у базі даних
      await User.update(
        { avatar: filePath },
        { where: { id: req.user.id } }
      )
  
      res.json({ 
        success: true, 
        avatar: filePath 
      })
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        message: 'Помилка при завантаженні аватара' 
      })
    }
  });
  
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
