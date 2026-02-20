const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { adminAuth, generateToken } = require('../middleware/auth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── POST /api/admin/login ──────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await pool.query(
      "SELECT * FROM customers WHERE email = $1 AND role = 'admin'",
      [email]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken(admin);
    res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.first_name } });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/admin/dashboard ───────────────────────────────
router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    // Total customers
    const customersResult = await pool.query(
      "SELECT COUNT(*) as total FROM customers WHERE role = 'customer'"
    );

    // Active subscriptions
    const activeSubs = await pool.query(
      "SELECT COUNT(*) as total FROM subscriptions WHERE status = 'active'"
    );

    // Revenue this month
    const monthRevenue = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) as total
       FROM orders WHERE status = 'paid'
       AND created_at >= date_trunc('month', CURRENT_DATE)`
    );

    // Revenue all time
    const totalRevenue = await pool.query(
      "SELECT COALESCE(SUM(amount_cents), 0) as total FROM orders WHERE status = 'paid'"
    );

    // Subscriptions by product
    const byProduct = await pool.query(
      `SELECT product_type, COUNT(*) as count
       FROM subscriptions WHERE status = 'active'
       GROUP BY product_type`
    );

    // Subscriptions by plan
    const byPlan = await pool.query(
      `SELECT plan_type, COUNT(*) as count
       FROM subscriptions WHERE status = 'active'
       GROUP BY plan_type`
    );

    // Recent signups (last 7 days)
    const recentSignups = await pool.query(
      `SELECT COUNT(*) as total FROM customers
       WHERE role = 'customer' AND created_at >= NOW() - INTERVAL '7 days'`
    );

    // Churn (canceled in last 30 days)
    const churn = await pool.query(
      `SELECT COUNT(*) as total FROM subscriptions
       WHERE status = 'canceled' AND canceled_at >= NOW() - INTERVAL '30 days'`
    );

    // MRR (Monthly Recurring Revenue)
    const mrr = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) as total
       FROM subscriptions WHERE status = 'active'`
    );

    res.json({
      stats: {
        totalCustomers: parseInt(customersResult.rows[0].total),
        activeSubscriptions: parseInt(activeSubs.rows[0].total),
        monthRevenue: parseInt(monthRevenue.rows[0].total),
        totalRevenue: parseInt(totalRevenue.rows[0].total),
        recentSignups: parseInt(recentSignups.rows[0].total),
        churn30d: parseInt(churn.rows[0].total),
        mrr: parseInt(mrr.rows[0].total)
      },
      byProduct: byProduct.rows,
      byPlan: byPlan.rows
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── GET /api/admin/customers ───────────────────────────────
router.get('/customers', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT c.*,
        (SELECT json_agg(json_build_object(
          'id', s.id, 'product_type', s.product_type, 'plan_type', s.plan_type,
          'status', s.status, 'amount_cents', s.amount_cents,
          'current_period_end', s.current_period_end
        )) FROM subscriptions s WHERE s.customer_id = c.id) as subscriptions
      FROM customers c
      WHERE c.role = 'customer'
    `;
    const params = [];

    if (search) {
      query += ` AND (c.email ILIKE $1 OR c.first_name ILIKE $1 OR c.last_name ILIKE $1)`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Total count
    const countResult = await pool.query(
      "SELECT COUNT(*) FROM customers WHERE role = 'customer'"
    );

    res.json({
      customers: result.rows.map(c => ({
        id: c.id,
        email: c.email,
        name: [c.first_name, c.last_name].filter(Boolean).join(' ') || '—',
        phone: c.phone,
        shipping: [c.shipping_street, c.shipping_city, c.shipping_state, c.shipping_zip].filter(Boolean).join(', ') || '—',
        stripeId: c.stripe_customer_id,
        mdiPatientId: c.mdi_patient_id,
        subscriptions: c.subscriptions || [],
        createdAt: c.created_at
      })),
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error('Customers list error:', err);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// ── GET /api/admin/subscriptions ───────────────────────────
router.get('/subscriptions', adminAuth, async (req, res) => {
  try {
    const { status = 'all', page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT s.*, c.email, c.first_name, c.last_name
      FROM subscriptions s
      JOIN customers c ON c.id = s.customer_id
    `;
    const params = [];

    if (status !== 'all') {
      query += ' WHERE s.status = $1';
      params.push(status);
    }

    query += ` ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      subscriptions: result.rows.map(s => ({
        id: s.id,
        customerEmail: s.email,
        customerName: [s.first_name, s.last_name].filter(Boolean).join(' ') || '—',
        productType: s.product_type,
        planType: s.plan_type,
        status: s.status,
        amount: s.amount_cents,
        periodEnd: s.current_period_end,
        cancelAt: s.cancel_at,
        createdAt: s.created_at
      }))
    });
  } catch (err) {
    console.error('Subscriptions list error:', err);
    res.status(500).json({ error: 'Failed to load subscriptions' });
  }
});

// ── GET /api/admin/orders ──────────────────────────────────
router.get('/orders', adminAuth, async (req, res) => {
  try {
    const { status = 'all', page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT o.*, c.email, c.first_name, c.last_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
    `;
    const params = [];

    if (status !== 'all') {
      query += ' WHERE o.status = $1';
      params.push(status);
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      orders: result.rows.map(o => ({
        id: o.id,
        customerEmail: o.email,
        customerName: [o.first_name, o.last_name].filter(Boolean).join(' ') || '—',
        productType: o.product_type,
        amount: o.amount_cents,
        status: o.status,
        pharmacyStatus: o.pharmacy_status,
        trackingNumber: o.tracking_number,
        createdAt: o.created_at
      }))
    });
  } catch (err) {
    console.error('Orders list error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// ── POST /api/admin/cancel-subscription ────────────────────
router.post('/cancel-subscription', adminAuth, async (req, res) => {
  try {
    const { subscriptionId, immediate = false } = req.body;

    const sub = await pool.query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE id = $1',
      [subscriptionId]
    );
    if (!sub.rows.length) return res.status(404).json({ error: 'Subscription not found' });

    const stripeSubId = sub.rows[0].stripe_subscription_id;

    if (immediate) {
      await stripe.subscriptions.cancel(stripeSubId);
    } else {
      // Cancel at end of current period
      await stripe.subscriptions.update(stripeSubId, {
        cancel_at_period_end: true
      });
    }

    // Log admin action
    await pool.query(
      `INSERT INTO admin_activity (admin_id, action, target_type, target_id, details)
       VALUES ($1, 'cancel_subscription', 'subscription', $2, $3)`,
      [req.user.id, subscriptionId, JSON.stringify({ immediate, stripeSubId })]
    );

    res.json({ success: true, message: immediate ? 'Canceled immediately' : 'Will cancel at period end' });
  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ── POST /api/admin/update-order-status ────────────────────
router.post('/update-order-status', adminAuth, async (req, res) => {
  try {
    const { orderId, status, pharmacyStatus, trackingNumber } = req.body;

    const updates = [];
    const values = [];
    let i = 1;

    if (status) { updates.push(`status = $${i++}`); values.push(status); }
    if (pharmacyStatus) { updates.push(`pharmacy_status = $${i++}`); values.push(pharmacyStatus); }
    if (trackingNumber) { updates.push(`tracking_number = $${i++}`); values.push(trackingNumber); }
    updates.push(`updated_at = NOW()`);

    values.push(orderId);
    await pool.query(
      `UPDATE orders SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Order update error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// ── GET /api/admin/revenue-chart ───────────────────────────
router.get('/revenue-chart', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         date_trunc('day', created_at) as date,
         SUM(amount_cents) as revenue,
         COUNT(*) as orders
       FROM orders
       WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY date_trunc('day', created_at)
       ORDER BY date`
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('Revenue chart error:', err);
    res.status(500).json({ error: 'Failed to load chart data' });
  }
});

// ── Seed admin (GET endpoint for initial setup) ────────────
router.get('/seed', async (req, res) => {
  try {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) return res.status(500).json({ error: 'Admin env vars not set' });

    const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.json({ message: 'Admin already exists' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO customers (email, first_name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)`,
      [email, hash]
    );

    res.json({ success: true, message: 'Admin account created' });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
