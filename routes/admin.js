const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { adminAuth, generateToken } = require('../middleware/auth');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

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
    const customersResult = await pool.query("SELECT COUNT(*) as total FROM customers WHERE role = 'customer'");
    const activeSubs = await pool.query("SELECT COUNT(*) as total FROM subscriptions WHERE status = 'active'");
    const monthRevenue = await pool.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM orders WHERE status = 'paid' AND created_at >= date_trunc('month', CURRENT_DATE)`);
    const totalRevenue = await pool.query("SELECT COALESCE(SUM(amount_cents), 0) as total FROM orders WHERE status = 'paid'");
    const byProduct = await pool.query(`SELECT product_type, COUNT(*) as count FROM subscriptions WHERE status = 'active' GROUP BY product_type`);
    const byPlan = await pool.query(`SELECT plan_type, COUNT(*) as count FROM subscriptions WHERE status = 'active' GROUP BY plan_type`);
    const recentSignups = await pool.query(`SELECT COUNT(*) as total FROM customers WHERE role = 'customer' AND created_at >= NOW() - INTERVAL '7 days'`);
    const churn = await pool.query(`SELECT COUNT(*) as total FROM subscriptions WHERE status = 'canceled' AND canceled_at >= NOW() - INTERVAL '30 days'`);
    const mrr = await pool.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM subscriptions WHERE status = 'active'`);

    // Revenue chart data (last 90 days)
    const revenueChart = await pool.query(
      `SELECT date_trunc('day', created_at) as date, SUM(amount_cents) as revenue, COUNT(*) as orders
       FROM orders WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '90 days'
       GROUP BY date_trunc('day', created_at) ORDER BY date`
    );

    // Page views this month
    const pageViews = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as total FROM page_views WHERE viewed_at >= date_trunc('month', CURRENT_DATE)`
    ).catch(() => ({ rows: [{ total: 0 }] }));

    // Today's visitors
    const todayVisitors = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as total FROM page_views WHERE viewed_at >= date_trunc('day', NOW())`
    ).catch(() => ({ rows: [{ total: 0 }] }));

    res.json({
      stats: {
        totalCustomers: parseInt(customersResult.rows[0].total),
        activeSubscriptions: parseInt(activeSubs.rows[0].total),
        monthRevenue: parseInt(monthRevenue.rows[0].total),
        totalRevenue: parseInt(totalRevenue.rows[0].total),
        recentSignups: parseInt(recentSignups.rows[0].total),
        churn30d: parseInt(churn.rows[0].total),
        mrr: parseInt(mrr.rows[0].total),
        monthlyVisitors: parseInt(pageViews.rows[0].total) || 0,
        todayVisitors: parseInt(todayVisitors.rows[0].total) || 0
      },
      byProduct: byProduct.rows,
      byPlan: byPlan.rows,
      revenueChart: revenueChart.rows,
      stripeConnected: !!process.env.STRIPE_SECRET_KEY,
      mdiConnected: !!process.env.MDI_API_KEY
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
        firstName: c.first_name,
        lastName: c.last_name,
        phone: c.phone,
        dob: c.dob,
        sex: c.sex,
        heightFt: c.height_ft,
        heightIn: c.height_in,
        weightLbs: c.weight_lbs,
        shipping: [c.shipping_street, c.shipping_city, c.shipping_state, c.shipping_zip].filter(Boolean).join(', ') || '—',
        shippingStreet: c.shipping_street,
        shippingApt: c.shipping_apt,
        shippingCity: c.shipping_city,
        shippingState: c.shipping_state,
        shippingZip: c.shipping_zip,
        treatmentProduct: c.treatment_product,
        intakeStatus: c.intake_status || 'pending',
        screeningClear: c.screening_clear,
        flaggedConditions: c.flagged_conditions,
        consents: c.consents,
        stripeId: c.stripe_customer_id,
        mdiPatientId: c.mdi_patient_id,
        visitorId: c.visitor_id,
        utmSource: c.utm_source,
        utmMedium: c.utm_medium,
        utmCampaign: c.utm_campaign,
        subscriptions: c.subscriptions || [],
        createdAt: c.created_at,
        updatedAt: c.updated_at
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

// ── GET /api/admin/analytics/live ───────────────────────────
router.get('/analytics/live', adminAuth, async (req, res) => {
  try {
    const active = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as total FROM page_views WHERE viewed_at >= NOW() - INTERVAL '5 minutes'`
    ).catch(() => ({ rows: [{ total: 0 }] }));
    const pages = await pool.query(
      `SELECT page_path as page, COUNT(*) as count FROM page_views
       WHERE viewed_at >= NOW() - INTERVAL '5 minutes'
       GROUP BY page_path ORDER BY count DESC LIMIT 8`
    ).catch(() => ({ rows: [] }));
    const today = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as total FROM page_views WHERE viewed_at >= date_trunc('day', NOW())`
    ).catch(() => ({ rows: [{ total: 0 }] }));
    res.json({
      activeVisitors: parseInt(active.rows[0]?.total || 0),
      todayVisitors: parseInt(today.rows[0]?.total || 0),
      pages: pages.rows.map(p => ({ page: p.page, count: parseInt(p.count) }))
    });
  } catch (err) {
    res.json({ activeVisitors: 0, todayVisitors: 0, pages: [] });
  }
});

// ── GET /api/admin/analytics/geo ───────────────────────────
// Returns visitor locations for the map
router.get('/analytics/geo', adminAuth, async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    const intervals = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
    const interval = intervals[period] || '24 hours';

    // Individual points for the map (recent visitors with geo)
    const points = await pool.query(
      `SELECT lat, lng, city, state, country, page_path, viewed_at
       FROM page_views
       WHERE lat IS NOT NULL AND viewed_at >= NOW() - INTERVAL '${interval}'
       ORDER BY viewed_at DESC LIMIT 200`
    ).catch(() => ({ rows: [] }));

    // Aggregated by state
    const byState = await pool.query(
      `SELECT state, country, COUNT(DISTINCT visitor_id) as visitors, COUNT(*) as views
       FROM page_views
       WHERE state IS NOT NULL AND viewed_at >= NOW() - INTERVAL '${interval}'
       GROUP BY state, country ORDER BY visitors DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));

    // Aggregated by city
    const byCity = await pool.query(
      `SELECT city, state, country, lat, lng, COUNT(DISTINCT visitor_id) as visitors
       FROM page_views
       WHERE city IS NOT NULL AND lat IS NOT NULL AND viewed_at >= NOW() - INTERVAL '${interval}'
       GROUP BY city, state, country, lat, lng ORDER BY visitors DESC LIMIT 30`
    ).catch(() => ({ rows: [] }));

    // Active right now with geo
    const activeGeo = await pool.query(
      `SELECT DISTINCT ON (visitor_id) lat, lng, city, state, page_path
       FROM page_views
       WHERE lat IS NOT NULL AND viewed_at >= NOW() - INTERVAL '5 minutes'
       ORDER BY visitor_id, viewed_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));

    res.json({
      points: points.rows,
      byState: byState.rows,
      byCity: byCity.rows,
      activeNow: activeGeo.rows
    });
  } catch (err) {
    console.error('Geo analytics error:', err);
    res.json({ points: [], byState: [], byCity: [], activeNow: [] });
  }
});

// ── GET /api/admin/analytics/funnel ────────────────────────
// Real conversion funnel with time frame
router.get('/analytics/funnel', adminAuth, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const intervals = { '7d': '7 days', '14d': '14 days', '30d': '30 days', '60d': '60 days', '90d': '90 days' };
    const interval = intervals[period] || '30 days';

    const pageViews = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as total FROM page_views WHERE viewed_at >= NOW() - INTERVAL '${interval}'`
    ).catch(() => ({ rows: [{ total: 0 }] }));

    const checkoutStarted = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as total FROM funnel_events WHERE event_type = 'checkout_started' AND created_at >= NOW() - INTERVAL '${interval}'`
    ).catch(() => ({ rows: [{ total: 0 }] }));

    const checkoutCompleted = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as total FROM funnel_events WHERE event_type = 'checkout_completed' AND created_at >= NOW() - INTERVAL '${interval}'`
    ).catch(() => ({ rows: [{ total: 0 }] }));

    const subscriptions = await pool.query(
      `SELECT COUNT(*) as total FROM subscriptions WHERE status = 'active' AND created_at >= NOW() - INTERVAL '${interval}'`
    ).catch(() => ({ rows: [{ total: 0 }] }));

    const signups = await pool.query(
      `SELECT COUNT(*) as total FROM customers WHERE role = 'customer' AND created_at >= NOW() - INTERVAL '${interval}'`
    ).catch(() => ({ rows: [{ total: 0 }] }));

    res.json({
      period,
      steps: [
        { label: 'Site Visitors', value: parseInt(pageViews.rows[0].total) },
        { label: 'Checkout Started', value: parseInt(checkoutStarted.rows[0].total) },
        { label: 'Checkout Completed', value: parseInt(checkoutCompleted.rows[0].total) },
        { label: 'Account Created', value: parseInt(signups.rows[0].total) },
        { label: 'Active Subscriber', value: parseInt(subscriptions.rows[0].total) },
      ]
    });
  } catch (err) {
    console.error('Funnel error:', err);
    res.status(500).json({ error: 'Failed to load funnel' });
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

// ── GET /api/admin/analytics/traffic-sources ────────────────
router.get('/analytics/traffic-sources', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const interval = days + ' days';
    
    // Get UTM sources from intake submissions
    const result = await pool.query(`
      SELECT 
        COALESCE(NULLIF(utm_source, ''), 
          CASE 
            WHEN referrer ILIKE '%instagram%' THEN 'Instagram'
            WHEN referrer ILIKE '%google%' THEN 'Google'
            WHEN referrer ILIKE '%tiktok%' THEN 'TikTok'
            WHEN referrer ILIKE '%facebook%' OR referrer ILIKE '%fb.%' THEN 'Facebook'
            WHEN referrer ILIKE '%twitter%' OR referrer ILIKE '%t.co%' THEN 'Twitter/X'
            WHEN referrer ILIKE '%youtube%' THEN 'YouTube'
            WHEN referrer ILIKE '%linkedin%' THEN 'LinkedIn'
            WHEN referrer ILIKE '%mail%' OR referrer ILIKE '%email%' THEN 'Email'
            WHEN referrer IS NOT NULL AND referrer != '' THEN 'Referral'
            ELSE 'Direct'
          END
        ) as source,
        COUNT(*) as visits
      FROM customers
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY source
      ORDER BY visits DESC
      LIMIT 10
    `);

    const sources = result.rows.map(r => ({
      source: r.source,
      visits: parseInt(r.visits)
    }));

    res.json({ sources });
  } catch (err) {
    console.error('Traffic sources error:', err);
    // Return defaults on error
    res.json({ sources: [
      {source:'Direct',visits:0},{source:'Instagram',visits:0},{source:'Google',visits:0},
      {source:'TikTok',visits:0},{source:'Facebook',visits:0},{source:'Twitter/X',visits:0},
      {source:'YouTube',visits:0},{source:'LinkedIn',visits:0},{source:'Email',visits:0},{source:'Referral',visits:0}
    ]});
  }
});

module.exports = router;
