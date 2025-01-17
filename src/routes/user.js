const express = require('express');
const multer = require('multer');
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;
const router = express.Router();

// Конфігурація multer для завантаження файлів
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
    cb(new Error('Недопустимий тип файлу. Дозволені лише JPEG, PNG та GIF'));
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB ліміт
  },
  fileFilter
});

// Middleware для аутентифікації
const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ message: 'Токен відсутній' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Недійсний токен' });
  }
};

// Хелпер для видалення старого аватара
const removeOldAvatar = async (userId) => {
  try {
    const { rows } = await pool.query('SELECT avatar_url FROM users WHERE id = $1', [userId]);
    
    if (rows[0]?.avatar_url) {
      const oldAvatarPath = path.join(process.env.UPLOAD_DIR, rows[0].avatar_url);
      await fs.unlink(oldAvatarPath);
    }
  } catch (error) {
    console.error('Помилка при видаленні старого аватара:', error);
  }
};

// Оновлений ендпоінт update-avatar для сумісності з фронтендом
router.put('/update-avatar', authenticate, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'Файл не завантажено' 
      });
    }

    const userId = req.user.userId;
    const avatarUrl = path.join(
      'avatars', 
      userId.toString(), 
      req.file.filename
    );

    // Видаляємо старий аватар
    await removeOldAvatar(userId);

    // Оновлюємо URL аватара в базі даних
    await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2',
      [avatarUrl, userId]
    );

    res.json({ 
      success: true,
      avatar: `/uploads/${avatarUrl}` // Додаємо префікс /uploads для фронтенду
    });
  } catch (error) {
    console.error('Помилка при оновленні аватара:', error);
    res.status(500).json({ 
      success: false,
      message: 'Помилка сервера при оновленні аватара' 
    });
  }
});

// Оновлений ендпоінт update-profile для сумісності з фронтендом
router.put('/update-profile', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, password } = req.body;
    const userId = req.user.userId;

    let updateQuery = `
      UPDATE users 
      SET 
        first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name)
    `;
    
    let values = [first_name, last_name];
    let paramCount = 2;

    if (password) {
      paramCount++;
      updateQuery += `, password = $${paramCount}`;
      values.push(password); // В реальному додатку тут має бути хешування
    }

    updateQuery += ` 
      WHERE id = $${paramCount + 1}
      RETURNING id, email, first_name, last_name, avatar_url
    `;
    
    values.push(userId);

    const { rows } = await pool.query(updateQuery, values);

    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Користувача не знайдено' 
      });
    }

    // Модифікуємо відповідь для сумісності з фронтендом
    const userData = rows[0];
    if (userData.avatar_url) {
      userData.avatar_url = `/uploads/${userData.avatar_url}`;
    }

    res.json({
      success: true,
      message: 'Профіль успішно оновлено',
      user: userData
    });
  } catch (error) {
    console.error('Помилка при оновленні профілю:', error);
    res.status(500).json({ 
      success: false,
      message: 'Помилка сервера при оновленні профілю' 
    });
  }
});

module.exports = router;