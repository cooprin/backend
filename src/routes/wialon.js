const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { checkObjectLimit } = require('../middleware/checkObjectLimit');
const WialonService = require('../services/wialon.service');

// Get list of objects with license info
router.get('/', authenticate, checkPermission('wialon_objects.read'), async (req, res) => {
    try {
        const result = await WialonService.getObjects(req.query);
        
        // Add license info
        const systemDomain = req.get('host') || req.headers.host;
        let licenseInfo = null;
        
        if (systemDomain) {
            try {
                const DirectusLicenseService = require('../services/DirectusLicenseService');
                const countResult = await pool.query(
                    'SELECT COUNT(*) as count FROM wialon.objects WHERE status = $1',
                    ['active']
                );
                
                const currentObjectsCount = parseInt(countResult.rows[0].count);
                const limitCheck = await DirectusLicenseService.checkObjectLimit(systemDomain, currentObjectsCount);
                
                licenseInfo = {
                    currentObjects: limitCheck.currentObjects,
                    objectLimit: limitCheck.objectLimit,
                    remainingObjects: limitCheck.remainingObjects,
                    warningLevel: limitCheck.warningLevel,
                    domain: systemDomain,
                    clientName: limitCheck.license?.client_name,
                    status: limitCheck.license?.status,
                    expiresAt: limitCheck.license?.expires_at
                };
                
            } catch (licenseError) {
                console.error('Error getting license info:', licenseError);
                licenseInfo = {
                    error: licenseError.message,
                    currentObjects: result.total
                };
            }
        }
        
        res.json({
            success: true,
            objects: result.objects,
            total: result.total,
            licenseInfo: licenseInfo
        });
    } catch (error) {
        console.error('Error fetching objects:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching objects list'
        });
    }
});

// Get single object
router.get('/:id', authenticate, checkPermission('wialon_objects.read'), async (req, res) => {
    try {
        const object = await WialonService.getObjectById(req.params.id);
        
        if (!object) {
            return res.status(404).json({
                success: false,
                message: 'Object not found'
            });
        }
        
        res.json({
            success: true,
            object
        });
    } catch (error) {
        console.error('Error fetching object:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching object data'
        });
    }
});

// Create object with limit check
router.post('/', authenticate, checkPermission('wialon_objects.create'), checkObjectLimit, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const newObject = await WialonService.createObject(
            client, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        // Form response with license warnings if any
        const response = {
            success: true,
            object: newObject
        };

        // Add license warning if exists
        if (req.licenseWarning) {
            response.licenseWarning = req.licenseWarning;
        }

        // Add current license info
        if (req.licenseInfo) {
            response.licenseInfo = req.licenseInfo;
        }
        
        res.status(201).json(response);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating object:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Error creating object'
        });
    } finally {
        client.release();
    }
});

// Update object (no limit check as we're not creating new)
router.put('/:id', authenticate, checkPermission('wialon_objects.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const result = await WialonService.updateObject(
            client, 
            req.params.id, 
            req.body, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            object: result.object,
            warnings: result.warnings
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating object:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Error updating object'
        });
    } finally {
        client.release();
    }
});

// Change object owner (no limit check)
router.post('/:id/change-owner', authenticate, checkPermission('wialon_objects.update'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const { client_id, notes, operation_date } = req.body;
        
        if (!client_id) {
            throw new Error('Client ID is required');
        }
        
        const updatedObject = await WialonService.changeOwner(
            client, 
            req.params.id, 
            req.body,
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            object: updatedObject
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error changing object owner:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Error changing object owner'
        });
    } finally {
        client.release();
    }
});

// Get object with payment info
router.get('/:id/payment-info', authenticate, checkPermission('wialon_objects.read'), async (req, res) => {
    try {
        const object = await WialonService.getObjectById(req.params.id);
        
        if (!object) {
            return res.status(404).json({
                success: false,
                message: 'Object not found'
            });
        }
        
        // Get payment periods info (if PaymentService exists)
        let paymentInfo = null;
        try {
            const PaymentService = require('../services/paymentService');
            const paidPeriods = await PaymentService.getObjectPaidPeriods(req.params.id);
            const nextUnpaidPeriod = await PaymentService.getNextUnpaidPeriod(req.params.id);
            
            paymentInfo = {
                paidPeriods,
                nextUnpaidPeriod
            };
        } catch (paymentError) {
            console.warn('PaymentService not available or error:', paymentError.message);
        }
        
        res.json({
            success: true,
            object,
            paymentInfo
        });
    } catch (error) {
        console.error('Error fetching object with payment info:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching object with payment information'
        });
    }
});

// Delete object (reduces license usage)
router.delete('/:id', authenticate, checkPermission('wialon_objects.delete'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await WialonService.deleteObject(
            client, 
            req.params.id, 
            req.user.userId,
            req
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Object successfully deleted'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting object:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Error deleting object'
        });
    } finally {
        client.release();
    }
});

module.exports = router;