const setBrowserInfo = (req, res, next) => {
    // Формуємо об'єкт з інформацією про браузер
    const browserInfo = {
        userAgent: req.headers['user-agent'],
        platform: req.headers['sec-ch-ua-platform'],
        mobile: req.headers['sec-ch-ua-mobile'],
        language: req.headers['accept-language'],
        referer: req.headers['referer'],
        // Додаткова інформація про браузер
        browser: {
            name: getBrowserName(req.headers['user-agent']),
            version: getBrowserVersion(req.headers['user-agent'])
        },
        // Інформація про клієнта
        client: {
            ip: req.ip,
            method: req.method,
            path: req.path
        }
    };

    // Зберігаємо в request для подальшого використання
    req.browserInfo = browserInfo;
    next();
};

// Функція для визначення назви браузера
const getBrowserName = (userAgent) => {
    if (!userAgent) return 'unknown';
    
    if (userAgent.includes('Firefox')) return 'Firefox';
    if (userAgent.includes('Chrome')) return 'Chrome';
    if (userAgent.includes('Safari')) return 'Safari';
    if (userAgent.includes('Edge')) return 'Edge';
    if (userAgent.includes('Opera')) return 'Opera';
    
    return 'unknown';
};

// Функція для визначення версії браузера
const getBrowserVersion = (userAgent) => {
    if (!userAgent) return 'unknown';
    
    const matches = userAgent.match(/(Firefox|Chrome|Safari|Edge|Opera)\/([0-9.]+)/);
    return matches ? matches[2] : 'unknown';
};

module.exports = setBrowserInfo;