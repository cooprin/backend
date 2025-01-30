const { pool } = require('../database');

const isAdmin = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.name as role_name 
       FROM users u 
       JOIN roles r ON u.role_id = r.id 
       WHERE u.id = $1`,
      [req.user.userId]
    );

    if (!result.rows.length || result.rows[0].role_name !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin rights required'
      });
    }
    next();
  } catch (error) {
    console.error('Error checking admin rights:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking permissions'
    });
  }
};

module.exports = isAdmin;