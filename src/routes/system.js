const express = require('express');
const router = express.Router();
const SystemService = require('../services/systemService');
const authenticate = require('../middleware/auth');

// GET /api/system/online-stats - отримати онлайн статистику
router.get('/online-stats', authenticate, async (req, res) => {
  try {
    const stats = await SystemService.getOnlineStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting online stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting online statistics'
    });
  }
});

// GET /api/system/status - отримати системний статус
router.get('/status', authenticate, async (req, res) => {
  try {
    const status = await SystemService.getSystemStatus();
    res.json({
      success: true,
      status
    });
  } catch (error) {
    console.error('Error getting system status:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting system status'
    });
  }
});

module.exports = router;