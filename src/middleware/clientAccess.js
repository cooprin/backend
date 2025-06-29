// Middleware to restrict client access to their own data only
const restrictToOwnData = (req, res, next) => {
  try {
    // Only apply to client users
    if (req.user?.userType !== 'client') {
      return next();
    }

    // Get client ID from authenticated user
    const clientId = req.user.clientId;
    
    if (!clientId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Client ID not found in token' 
      });
    }

    // Add client ID to request for filtering
    req.clientId = clientId;
    
    // Add clientId to query parameters for GET requests
    if (req.method === 'GET') {
      req.query.clientId = clientId;
    }
    
    // Add clientId to body for POST/PUT requests
    if (req.method === 'POST' || req.method === 'PUT') {
      if (req.body && typeof req.body === 'object') {
        req.body.client_id = clientId;
      }
    }

    next();
  } catch (error) {
    console.error('Error in client access restriction:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking client access'
    });
  }
};

// Middleware to ensure only staff can access admin endpoints
const staffOnly = (req, res, next) => {
  try {
    if (req.user?.userType !== 'staff') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Staff only.'
      });
    }
    next();
  } catch (error) {
    console.error('Error in staff only check:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking staff access'
    });
  }
};

// Middleware to allow both staff and clients
const staffOrClient = (req, res, next) => {
  try {
    if (!req.user?.userType || !['staff', 'client'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Invalid user type.'
      });
    }
    next();
  } catch (error) {
    console.error('Error in staff or client check:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking user access'
    });
  }
};

module.exports = {
  restrictToOwnData,
  staffOnly,
  staffOrClient
};