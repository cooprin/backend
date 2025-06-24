const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient } = require('../middleware/clientAccess');
const PDFService = require('../services/pdfService');

// Get client profile
router.get('/profile', authenticate, restrictToOwnData, async (req, res) => {
  try {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT 
        c.id, c.name, c.full_name, c.email, c.phone, c.address,
        c.contact_person, c.wialon_username, c.created_at,
        COUNT(DISTINCT o.id) as objects_count,
        COUNT(DISTINCT cd.id) as documents_count
       FROM clients.clients c
       LEFT JOIN wialon.objects o ON c.id = o.client_id
       LEFT JOIN clients.client_documents cd ON c.id = cd.client_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.user.clientId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    res.json({
      success: true,
      client: result.rows[0]
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

    const result = await pool.query(
      `SELECT 
        o.id, o.wialon_id, o.name, o.description, o.status,
        t.name as tariff_name, t.price as tariff_price,
        ot.effective_from as tariff_from
       FROM wialon.objects o
       LEFT JOIN billing.object_tariffs ot ON o.id = ot.object_id AND ot.effective_to IS NULL
       LEFT JOIN billing.tariffs t ON ot.tariff_id = t.id
       WHERE o.client_id = $1
       ORDER BY o.name`,
      [req.user.clientId]
    );

    res.json({
      success: true,
      objects: result.rows
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

    console.log('req.user:', req.user);
    console.log('Query params:', req.query);

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Build WHERE conditions
    let whereConditions = ['i.client_id = $1'];
    let queryParams = [req.user.clientId];
    let paramIndex = 2;

    if (req.query.status) {
      whereConditions.push(`i.status = $${paramIndex}`);
      queryParams.push(req.query.status);
      paramIndex++;
    }

    if (req.query.year) {
      whereConditions.push(`i.billing_year = $${paramIndex}`);
      queryParams.push(parseInt(req.query.year));
      paramIndex++;
    }

    if (req.query.month) {
      whereConditions.push(`i.billing_month = $${paramIndex}`);
      queryParams.push(parseInt(req.query.month));
      paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Get invoices with pagination
    const invoicesQuery = `
      SELECT 
        i.id, i.invoice_number, i.invoice_date, i.billing_month, 
        i.billing_year, i.total_amount, i.status, i.created_at,
        p.payment_date, p.amount as paid_amount
      FROM services.invoices i
      LEFT JOIN billing.payments p ON i.payment_id = p.id
      WHERE ${whereClause}
      ORDER BY i.billing_year DESC, i.billing_month DESC, i.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    console.log('SQL Query:', invoicesQuery);
    console.log('Query Params:', queryParams);

    const result = await pool.query(invoicesQuery, queryParams);

    // Get total count - ВИПРАВЛЕННЯ ТУТ
    const countQuery = `SELECT COUNT(*) FROM services.invoices i WHERE ${whereClause}`;
    // Беремо параметри БЕЗ limit та offset (останні 2 елементи)
    const countParams = queryParams.slice(0, -2);
    
    console.log('Count Query:', countQuery);
    console.log('Count Params:', countParams);
    
    const countResult = await pool.query(countQuery, countParams);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      invoices: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
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

    // Get invoice details
    const invoiceQuery = `
      SELECT 
        i.id, i.invoice_number, i.invoice_date, i.billing_month, 
        i.billing_year, i.total_amount, i.status, i.created_at,
        p.payment_date, p.amount as paid_amount
      FROM services.invoices i
      LEFT JOIN billing.payments p ON i.payment_id = p.id
      WHERE i.id = $1 AND i.client_id = $2
    `;

    const invoiceResult = await pool.query(invoiceQuery, [invoiceId, req.user.clientId]);

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const invoice = invoiceResult.rows[0];

    // Get invoice items
    const itemsQuery = `
      SELECT 
        ii.id, ii.service_id, ii.quantity, ii.unit_price, ii.total_price,
        ii.description, s.name as service_name
      FROM services.invoice_items ii
      LEFT JOIN services.services s ON ii.service_id = s.id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
    `;

    const itemsResult = await pool.query(itemsQuery, [invoiceId]);
    invoice.items = itemsResult.rows;

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

    // Verify invoice belongs to client
    const invoiceCheck = await pool.query(
      'SELECT id FROM services.invoices WHERE id = $1 AND client_id = $2',
      [invoiceId, req.user.clientId]
    );

    if (invoiceCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // Get invoice items
    const itemsQuery = `
      SELECT 
        ii.id, ii.service_id, ii.quantity, ii.unit_price, ii.total_price,
        ii.description, s.name as service_name
      FROM services.invoice_items ii
      LEFT JOIN services.services s ON ii.service_id = s.id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
    `;

    const result = await pool.query(itemsQuery, [invoiceId]);

    res.json({
      success: true,
      items: result.rows
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

    const result = await pool.query(
      `SELECT 
        cd.id, cd.document_name, cd.document_type, cd.file_path,
        cd.file_size, cd.description, cd.created_at
       FROM clients.client_documents cd
       WHERE cd.client_id = $1
       ORDER BY cd.created_at DESC`,
      [req.user.clientId]
    );

    res.json({
      success: true,
      documents: result.rows
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
    const offset = (page - 1) * limit;

    // Build WHERE conditions
    let whereConditions = ['t.client_id = $1'];
    let queryParams = [req.user.clientId];
    let paramIndex = 2;

    if (req.query.status) {
      whereConditions.push(`t.status = $${paramIndex}`);
      queryParams.push(req.query.status);
      paramIndex++;
    }

    if (req.query.priority) {
      whereConditions.push(`t.priority = $${paramIndex}`);
      queryParams.push(req.query.priority);
      paramIndex++;
    }

    if (req.query.category_id) {
      whereConditions.push(`t.category_id = $${paramIndex}`);
      queryParams.push(req.query.category_id);
      paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Get tickets with pagination
    const ticketsQuery = `
      SELECT 
        t.id, t.ticket_number, t.title, t.description, t.priority, t.status,
        t.created_at, t.resolved_at, t.closed_at,
        tc.name as category_name, tc.color as category_color,
        wo.name as object_name,
        COUNT(tcm.id) FILTER (WHERE tcm.is_internal = false) as comments_count
      FROM tickets.tickets t
      LEFT JOIN tickets.ticket_categories tc ON t.category_id = tc.id
      LEFT JOIN wialon.objects wo ON t.object_id = wo.id
      LEFT JOIN tickets.ticket_comments tcm ON t.id = tcm.ticket_id
      WHERE ${whereClause}
      GROUP BY t.id, tc.name, tc.color, wo.name
      ORDER BY t.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    const result = await pool.query(ticketsQuery, queryParams);

    // Get total count
    const countQuery = `
      SELECT COUNT(*) FROM tickets.tickets t WHERE ${whereClause}
    `;
    const countResult = await pool.query(countQuery, queryParams.slice(0, paramIndex - 2));

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      tickets: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
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

    // Verify invoice belongs to client
    const invoiceCheck = await pool.query(
      'SELECT id FROM services.invoices WHERE id = $1 AND client_id = $2',
      [invoiceId, req.user.clientId]
    );

    if (invoiceCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // Get invoice documents
    const documentsQuery = `
      SELECT 
        id, document_name, document_type, file_size, created_at
      FROM services.invoice_documents 
      WHERE invoice_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(documentsQuery, [invoiceId]);

    res.json({
      success: true,
      documents: result.rows
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

    // Get document with invoice verification
    const documentQuery = `
      SELECT 
        id.document_name, id.file_path, id.document_type
      FROM services.invoice_documents id
      JOIN services.invoices i ON id.invoice_id = i.id
      WHERE id.id = $1 AND i.client_id = $2
    `;

    const result = await pool.query(documentQuery, [documentId, req.user.clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    const document = result.rows[0];
    const filePath = path.join(process.env.UPLOAD_DIR, document.file_path);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${document.document_name}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    // Send file
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error downloading invoice document:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;