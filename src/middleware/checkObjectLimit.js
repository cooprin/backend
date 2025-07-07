const { pool } = require('../database');
const DirectusLicenseService = require('../services/DirectusLicenseService');

/**
 * Middleware to check object limit before creation
 */
const checkObjectLimit = async (req, res, next) => {
    try {
        // Get system domain
        const systemDomain = req.get('host') || req.headers.host;

        
        if (!systemDomain) {
            return res.status(500).json({
                success: false,
                message: 'Unable to determine system domain',
                code: 'DOMAIN_NOT_FOUND'
            });
        }

        // Count current active objects
        const countResult = await pool.query(
            'SELECT COUNT(*) as count FROM wialon.objects WHERE status = $1',
            ['active']
        );
        
        const currentObjectsCount = parseInt(countResult.rows[0].count);

        // Check limit through Directus
        const limitCheck = await DirectusLicenseService.checkObjectLimit(systemDomain, currentObjectsCount);

        // If license error, check offline allowance
        if (limitCheck.error) {
            console.warn(`License check error for ${systemDomain}:`, limitCheck.error);
            
            // Check offline daily allowance
            const offlineCheck = await checkOfflineDailyLimit();
            
            if (!offlineCheck.allowed) {
                return res.status(503).json({
                    success: false,
                    message: 'License verification failed and daily offline limit reached',
                    description: `Cannot verify license. Offline mode allows ${offlineCheck.dailyLimit} object(s) per day. Today created: ${offlineCheck.usedToday}/${offlineCheck.dailyLimit}`,
                    code: 'OFFLINE_DAILY_LIMIT_REACHED',
                    offlineInfo: {
                        usedToday: offlineCheck.usedToday,
                        dailyLimit: offlineCheck.dailyLimit,
                        nextResetTime: offlineCheck.nextResetTime,
                        error: limitCheck.error
                    }
                });
            }
            
            req.licenseWarning = {
                type: 'offline',
                message: 'Operating in offline mode',
                description: `License server unavailable. Using offline quota: ${offlineCheck.usedToday + 1}/${offlineCheck.dailyLimit} for today.`,
                offlineInfo: {
                    usedToday: offlineCheck.usedToday,
                    dailyLimit: offlineCheck.dailyLimit,
                    nextResetTime: offlineCheck.nextResetTime
                }
            };
            
            return next();
        }

        // If limit reached - block
        if (!limitCheck.allowed) {
            return res.status(403).json({
                success: false,
                message: 'Object limit reached in the system',
                description: `Your license allows a maximum of ${limitCheck.objectLimit} objects. Currently in system: ${limitCheck.currentObjects} objects.`,
                supportMessage: 'Please contact support to increase the limit.',
                code: 'OBJECT_LIMIT_REACHED',
                licenseInfo: {
                    currentObjects: limitCheck.currentObjects,
                    objectLimit: limitCheck.objectLimit,
                    remainingObjects: limitCheck.remainingObjects,
                    clientName: limitCheck.license?.client_name,
                    domain: systemDomain
                }
            });
        }

        // If critically low space - add warning
        if (limitCheck.warningLevel === 'critical') {
            req.licenseWarning = {
                type: 'critical',
                message: `Warning! Only ${limitCheck.remainingObjects} object slots remaining`,
                description: `Out of ${limitCheck.objectLimit} objects limit, only ${limitCheck.remainingObjects} remaining. We recommend upgrading your license.`,
                licenseInfo: {
                    currentObjects: limitCheck.currentObjects,
                    objectLimit: limitCheck.objectLimit,
                    remainingObjects: limitCheck.remainingObjects
                }
            };
        }

        // Add license info to request for use in controllers
        req.licenseInfo = {
            currentObjects: limitCheck.currentObjects,
            objectLimit: limitCheck.objectLimit,
            remainingObjects: limitCheck.remainingObjects,
            domain: systemDomain,
            license: limitCheck.license
        };

        next();

    } catch (error) {
        console.error('Error in checkObjectLimit middleware:', error);
        
        // On critical error, log but allow to continue
        req.licenseWarning = {
            type: 'error',
            message: 'License verification error',
            description: `Failed to verify license: ${error.message}`
        };
        
        next();
    }
};

/**
 * Middleware to get license stats (without blocking)
 */
const getLicenseStats = async (req, res, next) => {
    try {
        const systemDomain = req.get('host') || req.headers.host;
        
        if (!systemDomain) {
            return next();
        }

        // Count current objects
        const countResult = await pool.query(
            'SELECT COUNT(*) as count FROM wialon.objects WHERE status = $1',
            ['active']
        );
        
        const currentObjectsCount = parseInt(countResult.rows[0].count);

        // Get license stats
        const stats = await DirectusLicenseService.getLicenseStats(systemDomain);

        req.licenseStats = {
            ...stats,
            currentObjects: currentObjectsCount,
            domain: systemDomain
        };

        next();

    } catch (error) {
        console.error('Error getting license stats:', error);
        next();
    }
};

/**
 * Check if we can create object offline (1 per day limit)
 */
const checkOfflineDailyLimit = async () => {
    try {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        // Знайти кількість об'єктів створених сьогодні (по updated_at)
        const result = await pool.query(`
            SELECT COUNT(*) as objects_created_today
            FROM wialon.objects 
            WHERE DATE(updated_at) = CURRENT_DATE
        `);
        
        const objectsCreatedToday = parseInt(result.rows[0].objects_created_today);
        const dailyLimit = 1; // Ліміт 1 об'єкт на день в offline режимі
        
        return {
            allowed: objectsCreatedToday < dailyLimit,
            usedToday: objectsCreatedToday,
            dailyLimit: dailyLimit,
            date: today,
            nextResetTime: `${today} 23:59:59`
        };
        
    } catch (error) {
        console.error('Error checking offline daily limit:', error);
        // В разі помилки з БД - блокуємо створення (безпечний режим)
        return {
            allowed: false,
            usedToday: 0,
            dailyLimit: 1,
            error: error.message
        };
    }
};

module.exports = {
    checkObjectLimit,
    getLicenseStats,
    checkOfflineDailyLimit
};