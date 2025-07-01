const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData } = require('../middleware/clientAccess');
const AuditService = require('../services/auditService');
const PortalService = require('../services/portalService');
const { ENTITY_TYPES, AUDIT_TYPES, AUDIT_LOG_TYPES } = require('../constants/constants');
const path = require('path');
const fs = require('fs');

// Get client profile
router.get('/profile', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const client = await PortalService.getClientProfile(req.user.clientId);

        if (!client) {
            return res.status(404).json({ success: false, message: 'Client not found' });
        }

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_PROFILE,
                entityType: ENTITY_TYPES.CLIENT,
                entityId: req.user.clientId,
                newValues: {
                    action: 'view_profile',
                    client_id: req.user.clientId,
                    client_name: client.name
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            client
        });
    } catch (error) {
        console.error('Error fetching client profile:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get client objects
router.get('/objects', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const objects = await PortalService.getClientObjects(req.user.clientId);

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_OBJECTS,
                entityType: ENTITY_TYPES.WIALON_OBJECT,
                entityId: null,
                newValues: {
                    action: 'view_objects',
                    client_id: req.user.clientId,
                    objects_count: objects.length
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            objects
        });
    } catch (error) {
        console.error('Error fetching client objects:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get client invoices
router.get('/invoices', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const filters = {
            status: req.query.status,
            year: req.query.year,
            month: req.query.month
        };

        const result = await PortalService.getClientInvoices(
            req.user.clientId, 
            filters, 
            page, 
            limit
        );

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_INVOICES,
                entityType: ENTITY_TYPES.INVOICE,
                entityId: null,
                newValues: {
                    action: 'view_invoices',
                    client_id: req.user.clientId,
                    filters,
                    page,
                    limit,
                    total_found: result.pagination.total
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching client invoices:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get single invoice details
router.get('/invoices/:id', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const invoiceId = req.params.id;
        const invoice = await PortalService.getInvoiceDetails(invoiceId, req.user.clientId);

        if (!invoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_INVOICES,
                entityType: ENTITY_TYPES.INVOICE,
                entityId: invoiceId,
                newValues: {
                    action: 'view_invoice_details',
                    client_id: req.user.clientId,
                    invoice_id: invoiceId,
                    invoice_number: invoice.invoice_number
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            invoice
        });
    } catch (error) {
        console.error('Error fetching invoice details:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get invoice items
router.get('/invoices/:id/items', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const invoiceId = req.params.id;
        const items = await PortalService.getInvoiceItems(invoiceId, req.user.clientId);

        if (!items) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_INVOICES,
                entityType: ENTITY_TYPES.INVOICE,
                entityId: invoiceId,
                newValues: {
                    action: 'view_invoice_items',
                    client_id: req.user.clientId,
                    invoice_id: invoiceId,
                    items_count: items.length
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            items
        });
    } catch (error) {
        console.error('Error fetching invoice items:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get client documents
router.get('/documents', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const documents = await PortalService.getClientDocuments(req.user.clientId);

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_DOCUMENTS,
                entityType: ENTITY_TYPES.CLIENT_DOCUMENT,
                entityId: null,
                newValues: {
                    action: 'view_documents',
                    client_id: req.user.clientId,
                    documents_count: documents.length
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            documents
        });
    } catch (error) {
        console.error('Error fetching client documents:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get client payment status (Wialon)
router.get('/payment-status', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const ClientService = require('../services/clients.service');
        const paymentInfo = await ClientService.getClientPaymentInfo(req.user.clientId);
        
        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_PAYMENT_STATUS,
                entityType: ENTITY_TYPES.CLIENT,
                entityId: req.user.clientId,
                newValues: {
                    action: 'view_payment_status',
                    client_id: req.user.clientId
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }
        
        res.json({
            success: true,
            paymentInfo
        });
    } catch (error) {
        console.error('Error fetching client payment status:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Помилка при отриманні платіжної інформації'
        });
    }
});

// Get client tickets
router.get('/tickets', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const filters = {
            status: req.query.status,
            priority: req.query.priority,
            category_id: req.query.category_id
        };

        const result = await PortalService.getClientTickets(
            req.user.clientId,
            filters,
            page,
            limit
        );

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_TICKETS,
                entityType: ENTITY_TYPES.TICKET,
                entityId: null,
                newValues: {
                    action: 'view_tickets',
                    client_id: req.user.clientId,
                    filters,
                    page,
                    limit,
                    total_found: result.pagination.total
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching client tickets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get invoice documents
router.get('/invoices/:id/documents', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const invoiceId = req.params.id;
        const documents = await PortalService.getInvoiceDocuments(invoiceId, req.user.clientId);

        if (!documents) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_INVOICES,
                entityType: ENTITY_TYPES.INVOICE,
                entityId: invoiceId,
                newValues: {
                    action: 'view_invoice_documents',
                    client_id: req.user.clientId,
                    invoice_id: invoiceId,
                    documents_count: documents.length
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            documents
        });
    } catch (error) {
        console.error('Error fetching invoice documents:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Download invoice document
router.get('/invoice-documents/:id/download', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const documentId = req.params.id;
        const document = await PortalService.getInvoiceDocumentForDownload(documentId, req.user.clientId);

        if (!document) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        const filePath = path.join(process.env.UPLOAD_DIR, document.file_path);

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'File not found' });
        }

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.DOWNLOAD_DOCUMENT,
                entityType: ENTITY_TYPES.INVOICE,
                entityId: documentId,
                newValues: {
                    action: 'download_invoice_document',
                    client_id: req.user.clientId,
                    document_id: documentId,
                    document_name: document.document_name
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        // Set headers for download
        res.setHeader('Content-Disposition', `attachment; filename="${document.document_name}"`);
        res.setHeader('Content-Type', 'application/octet-stream');

        // Send file
        const absolutePath = path.resolve(filePath);
        res.sendFile(absolutePath);
    } catch (error) {
        console.error('Error downloading invoice document:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get dashboard statistics
router.get('/dashboard/stats', authenticate, restrictToOwnData, async (req, res) => {
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const stats = await PortalService.getClientDashboardStats(req.user.clientId);

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.VIEW_DASHBOARD,
                entityType: ENTITY_TYPES.CLIENT,
                entityId: req.user.clientId,
                newValues: {
                    action: 'view_dashboard_stats',
                    client_id: req.user.clientId
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Create new ticket (client portal)
router.post('/tickets', authenticate, restrictToOwnData, async (req, res) => {
    const client = await pool.connect();
    try {
        if (req.user.userType !== 'client') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { title, description, category_id, object_id, priority = 'medium' } = req.body;

        // Validate required fields
        if (!title || !description) {
            return res.status(400).json({ 
                success: false, 
                message: 'Title and description are required' 
            });
        }

        await client.query('BEGIN');

        const ticket = await PortalService.createClientTicket(
            client,
            req.user.clientId,
            { title, description, category_id, object_id, priority }
        );

        await client.query('COMMIT');

        // Audit log
        try {
            await AuditService.log({
                clientId: req.user.clientId,
                userType: 'client',
                actionType: AUDIT_LOG_TYPES.CLIENT_PORTAL.CREATE_TICKET,
                entityType: ENTITY_TYPES.TICKET,
                entityId: ticket.id,
                newValues: {
                    ticket_id: ticket.id,
                    ticket_number: ticket.ticket_number,
                    title: ticket.title,
                    client_id: req.user.clientId,
                    category_id: ticket.category_id,
                    priority: ticket.priority
                },
                ipAddress: req.ip,
                auditType: AUDIT_TYPES.BUSINESS,
                req
            });
        } catch (auditError) {
            console.error('Audit log failed:', auditError);
        }

        res.status(201).json({
            success: true,
            ticket
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating ticket:', error);
        
        if (error.message === 'Object not found or access denied') {
            return res.status(400).json({ success: false, message: error.message });
        }
        
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

module.exports = router;