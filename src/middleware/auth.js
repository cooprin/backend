const jwt = require('jsonwebtoken');

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token is missing' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Додаємо детальне логування
    console.log('Decoded token data:', {
      userId: decoded.userId,
      email: decoded.email,
      permissions: decoded.permissions,
      iat: new Date(decoded.iat * 1000).toISOString(), // час створення токену
      exp: new Date(decoded.exp * 1000).toISOString(), // час закінчення токену
      fullDecoded: decoded // весь розшифрований об'єкт
    });
    
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      permissions: decoded.permissions
    };


    
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

module.exports = authenticate;