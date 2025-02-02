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
   //
   
   //Для профайлу
   
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
   
   //