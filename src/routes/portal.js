const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const authenticate = require('../middleware/auth');
const { restrictToOwnData, staffOrClient } = require('../middleware/clientAccess');

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

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT 
        i.id, i.invoice_number, i.invoice_date, i.billing_month, 
        i.billing_year, i.total_amount, i.status,
        p.payment_date, p.amount as paid_amount
       FROM services.invoices i
       LEFT JOIN billing.payments p ON i.payment_id = p.id
       WHERE i.client_id = $1
       ORDER BY i.billing_year DESC, i.billing_month DESC
       LIMIT $2 OFFSET $3`,
      [req.user.clientId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM services.invoices WHERE client_id = $1',
      [req.user.clientId]
    );

    res.json({
      success: true,
      invoices: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching client invoices:', error);
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

module.exports = router;