const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { getLicenseStats } = require('../middleware/checkObjectLimit');
const DirectusLicenseService = require('../services/DirectusLicenseService');

// Get current license info and usage
router.get('/info', authenticate, getLicenseStats, async (req, res) => {
    try {
        const systemDomain = req.get('host') || req.headers.host;
        
        if (!systemDomain) {
            return res.status(400).json({
                success: false,
                message: 'Unable to determine system domain'
            });
        }

        // Get stats from middleware
        const licenseStats = req.licenseStats;
        
        if (!licenseStats) {
            return res.status(404).json({
                success: false,
                message: 'License information unavailable'
            });
        }

        // Calculate usage by status
        const statusStats = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count
            FROM wialon.objects 
            GROUP BY status
            ORDER BY status
        `);

        // Creation stats for last 30 days
        const creationStats = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as objects_created
            FROM wialon.objects 
            WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
            LIMIT 30
        `);

        res.json({
            success: true,
            license: {
                domain: systemDomain,
                clientName: licenseStats.license?.client_name,
                objectLimit: licenseStats.license?.object_limit,
                status: licenseStats.license?.status,
                expiresAt: licenseStats.license?.expires_at,
                contactEmail: licenseStats.license?.contact_email,
                notes: licenseStats.license?.notes
            },
            usage: {
                currentObjects: licenseStats.currentObjects,
                objectLimit: licenseStats.license?.object_limit,
                remainingObjects: (licenseStats.license?.object_limit || 0) - licenseStats.currentObjects,
                usagePercentage: licenseStats.license?.object_limit ? 
                    Math.round((licenseStats.currentObjects / licenseStats.license.object_limit) * 100) : 0
            },
            statistics: {
                byStatus: statusStats.rows,
                recentCreations: creationStats.rows,
                totalChecks: licenseStats.stats?.totalChecks || 0,
                lastCheck: licenseStats.stats?.lastCheck
            },
            recentLogs: licenseStats.recentLogs?.slice(0, 10) || []
        });

    } catch (error) {
        console.error('Error fetching license info:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching license information',
            error: error.message
        });
    }
});

// Get detailed usage logs
router.get('/usage-logs', authenticate, checkPermission('wialon_objects.read'), async (req, res) => {
    try {
        const systemDomain = req.get('host') || req.headers.host;
        const { 
            page = 1, 
            perPage = 20, 
            dateFrom, 
            dateTo, 
            action 
        } = req.query;

        if (!systemDomain) {
            return res.status(400).json({
                success: false,
                message: 'Unable to determine system domain'
            });
        }

        const stats = await DirectusLicenseService.getLicenseStats(systemDomain);
        
        // Filter logs
        let filteredLogs = stats.recentLogs || [];
        
        if (dateFrom) {
            filteredLogs = filteredLogs.filter(log => 
                new Date(log.checked_at) >= new Date(dateFrom)
            );
        }
        
        if (dateTo) {
            filteredLogs = filteredLogs.filter(log => 
                new Date(log.checked_at) <= new Date(dateTo + 'T23:59:59')
            );
        }
        
        if (action) {
            filteredLogs = filteredLogs.filter(log => log.action === action);
        }

        // Pagination
        const startIndex = (parseInt(page) - 1) * parseInt(perPage);
        const endIndex = startIndex + parseInt(perPage);
        const paginatedLogs = filteredLogs.slice(startIndex, endIndex);

        // Action statistics
        const actionStats = filteredLogs.reduce((acc, log) => {
            acc[log.action] = (acc[log.action] || 0) + 1;
            return acc;
        }, {});

        res.json({
            success: true,
            logs: paginatedLogs,
            pagination: {
                page: parseInt(page),
                perPage: parseInt(perPage),
                total: filteredLogs.length,
                totalPages: Math.ceil(filteredLogs.length / parseInt(perPage))
            },
            statistics: {
                actionBreakdown: actionStats,
                totalLogs: filteredLogs.length
            }
        });

    } catch (error) {
        console.error('Error fetching usage logs:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching usage logs',
            error: error.message
        });
    }
});

// Refresh license cache (admin only)
router.post('/refresh-cache', authenticate, checkPermission('wialon_objects.update'), async (req, res) => {
    try {
        const systemDomain = req.get('host') || req.headers.host;
        
        if (!systemDomain) {
            return res.status(400).json({
                success: false,
                message: 'Unable to determine system domain'
            });
        }

        // Clear cache for this domain
        DirectusLicenseService.clearCache(systemDomain);

        // Get fresh data
        const license = await DirectusLicenseService.getSystemLicense(systemDomain);

        res.json({
            success: true,
            message: 'License cache refreshed',
            license: {
                domain: systemDomain,
                clientName: license.client_name,
                objectLimit: license.object_limit,
                status: license.status,
                expiresAt: license.expires_at
            }
        });

    } catch (error) {
        console.error('Error refreshing license cache:', error);
        res.status(500).json({
            success: false,
            message: 'Error refreshing license cache',
            error: error.message
        });
    }
});

// Check Directus availability
router.get('/health', authenticate, async (req, res) => {
    try {
        const systemDomain = req.get('host') || req.headers.host;
        
        if (!systemDomain) {
            return res.status(400).json({
                success: false,
                message: 'Unable to determine system domain'
            });
        }

        // Try to get license
        const startTime = Date.now();
        const license = await DirectusLicenseService.getSystemLicense(systemDomain);
        const responseTime = Date.now() - startTime;

        res.json({
            success: true,
            message: 'Directus is available',
            health: {
                directusUrl: process.env.DIRECTUS_URL || 'https://admin.cooprin.com.ua',
                responseTime: `${responseTime}ms`,
                licenseStatus: license.status,
                lastCheck: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Directus health check failed:', error);
        res.status(503).json({
            success: false,
            message: 'Directus unavailable',
            health: {
                directusUrl: process.env.DIRECTUS_URL || 'https://admin.cooprin.com.ua',
                error: error.message,
                lastCheck: new Date().toISOString()
            }
        });
    }
});

// Dashboard widget - short license info
router.get('/widget', authenticate, async (req, res) => {
    try {
        const systemDomain = req.get('host') || req.headers.host;
        
        if (!systemDomain) {
            return res.json({
                success: false,
                message: 'Domain not determined'
            });
        }

        // Count objects
        const countResult = await pool.query(
            'SELECT COUNT(*) as count FROM wialon.objects WHERE status = $1',
            ['active']
        );
        
        const currentObjects = parseInt(countResult.rows[0].count);

        // Check limit
        const limitCheck = await DirectusLicenseService.checkObjectLimit(systemDomain, currentObjects);

        let warningLevel = 'ok';
        let warningMessage = null;

        if (!limitCheck.allowed) {
            warningLevel = 'critical';
            warningMessage = 'Object limit reached';
        } else if (limitCheck.remainingObjects <= 10) {
            warningLevel = 'warning';
            warningMessage = `${limitCheck.remainingObjects} objects remaining`;
        }

        res.json({
            success: true,
            widget: {
                currentObjects,
                objectLimit: limitCheck.objectLimit,
                remainingObjects: limitCheck.remainingObjects,
                usagePercentage: limitCheck.objectLimit ? 
                    Math.round((currentObjects / limitCheck.objectLimit) * 100) : 0,
                warningLevel,
                warningMessage,
                clientName: limitCheck.license?.client_name,
                status: limitCheck.license?.status
            }
        });

    } catch (error) {
        console.error('Error fetching license widget:', error);
        res.json({
            success: false,
            widget: {
                error: 'Error loading',
                warningLevel: 'error'
            }
        });
    }
});

module.exports = router;