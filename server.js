require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ───────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    // Allow same-origin (Render URL) and configured origins
    if (allowedOrigins.includes(origin) || origin.includes('onrender.com') || origin.includes('clyr.health') || origin.includes('clyr-marketing') || origin.includes('github.io') || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// ── Stripe webhook needs raw body ──────────────────────────
// Must be BEFORE express.json()
const webhookRoutes = require('./routes/webhooks');
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRoutes);

// ── JSON parsing for everything else ───────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Root route ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: process.env.BRAND_NAME || 'Telehealth Backend',
    status: 'running',
    endpoints: {
      health: '/api/health',
      products: '/api/products',
      admin: '/admin.html'
    }
  });
});

// ── Health check (before everything) ───────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    brand: process.env.BRAND_NAME || 'Telehealth Backend',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ── Static files (admin dashboard) ─────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ─────────────────────────────────────────────────
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/admin');
const intakeRoutes = require('./routes/intake');

app.use('/api', checkoutRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/intake', intakeRoutes);

// ── Public page view tracker (no auth) ─────────────────────
app.post('/api/track', async (req, res) => {
  try {
    const { page, visitor_id, referrer, event, lat, lng, city, state, country } = req.body;
    if (!page && !event) return res.status(400).json({ error: 'page or event required' });
    const vid = visitor_id || req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'anon-' + Date.now();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;

    if (page) {
      // If client sent geo, use it; otherwise try server-side lookup
      let geoLat = lat || null, geoLng = lng || null, geoCity = city || null, geoState = state || null, geoCountry = country || null;

      if (!geoLat && ip && ip !== '127.0.0.1' && ip !== '::1') {
        try {
          const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,lat,lon`);
          const geo = await geoRes.json();
          if (geo.status === 'success') {
            geoLat = geo.lat; geoLng = geo.lon; geoCity = geo.city; geoState = geo.regionName; geoCountry = geo.country;
          }
        } catch(e) { /* geo lookup failed, continue without */ }
      }

      await pool.query(
        `INSERT INTO page_views (visitor_id, page_path, referrer, ip_address, city, state, country, lat, lng, viewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [vid, page, referrer || null, ip, geoCity, geoState, geoCountry, geoLat, geoLng]
      ).catch(() => {});

      // Also log as funnel event
      await pool.query(
        `INSERT INTO funnel_events (visitor_id, event_type, created_at) VALUES ($1, 'page_view', NOW())`,
        [vid]
      ).catch(() => {});
    }

    if (event) {
      // Track funnel events: checkout_started, checkout_completed, subscription_created
      await pool.query(
        `INSERT INTO funnel_events (visitor_id, event_type, metadata, created_at) VALUES ($1, $2, $3, NOW())`,
        [vid, event, req.body.metadata ? JSON.stringify(req.body.metadata) : null]
      ).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) { res.json({ ok: true }); }
});

// ── MDI redirect — sends user to MDI intake after payment ──
app.get('/api/intake-redirect', (req, res) => {
  const intakeUrl = process.env.MDI_INTAKE_URL;
  if (!intakeUrl) return res.status(500).json({ error: 'MDI intake URL not configured' });

  const { email, product, session_id } = req.query;
  // Redirect to MDI white-label intake with pre-filled email
  const redirectUrl = `${intakeUrl}?email=${encodeURIComponent(email || '')}&product=${encodeURIComponent(product || '')}`;
  res.redirect(redirectUrl);
});

// ── Database initialization on first run ───────────────────
const pool = require('./config/database');
async function ensureTables() {
  try {
    await pool.query('SELECT 1 FROM customers LIMIT 1');
    console.log('✓ Database tables exist');
    // Run migrations for new tables/columns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS page_views (
        id SERIAL PRIMARY KEY, visitor_id VARCHAR(255) NOT NULL, page_path VARCHAR(500) NOT NULL,
        referrer VARCHAR(500), ip_address VARCHAR(45), city VARCHAR(100), state VARCHAR(100),
        country VARCHAR(100), lat DECIMAL(9,6), lng DECIMAL(9,6), viewed_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS funnel_events (
        id SERIAL PRIMARY KEY, visitor_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(50) NOT NULL, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS intake_submissions (
        id SERIAL PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        email VARCHAR(255) NOT NULL, first_name VARCHAR(100), last_name VARCHAR(100), phone VARCHAR(20),
        dob DATE, sex VARCHAR(20), height_ft INTEGER, height_in INTEGER, weight_lbs INTEGER,
        treatment_product VARCHAR(50), screening_clear BOOLEAN DEFAULT FALSE, flagged_conditions TEXT[],
        consents JSONB, shipping_street VARCHAR(255), shipping_apt VARCHAR(100), shipping_city VARCHAR(100),
        shipping_state VARCHAR(2), shipping_zip VARCHAR(10), ip_address VARCHAR(45), visitor_id VARCHAR(255),
        utm_source VARCHAR(255), utm_medium VARCHAR(255), utm_campaign VARCHAR(255),
        status VARCHAR(30) DEFAULT 'submitted', created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_page_views_time ON page_views(viewed_at);
      CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_funnel_events_type ON funnel_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_funnel_events_time ON funnel_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_intake_submissions_email ON intake_submissions(email);
      CREATE INDEX IF NOT EXISTS idx_intake_submissions_status ON intake_submissions(status);
    `).catch(e => console.log('Migration note:', e.message));
    // Add columns if they don't exist (safe for existing tables)
    const pvCols = ['ip_address VARCHAR(45)', 'city VARCHAR(100)', 'state VARCHAR(100)', 'country VARCHAR(100)', 'lat DECIMAL(9,6)', 'lng DECIMAL(9,6)'];
    for (const col of pvCols) { await pool.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {}); }
    const custCols = [
      'dob DATE','sex VARCHAR(20)','height_ft INTEGER','height_in INTEGER','weight_lbs INTEGER',
      'shipping_apt VARCHAR(100)','treatment_product VARCHAR(50)','intake_status VARCHAR(30)',
      'screening_clear BOOLEAN','flagged_conditions TEXT[]','consents JSONB',
      'utm_source VARCHAR(255)','utm_medium VARCHAR(255)','utm_campaign VARCHAR(255)','visitor_id VARCHAR(255)'];
    for (const col of custCols) {
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ${col}`).catch(e => console.log('Col migration:', col, e.message));
    }
    console.log('✓ Migrations applied');
  } catch (err) {
    console.log('Initializing database tables...');
    const { execSync } = require('child_process');
    try { execSync('node scripts/init-db.js', { stdio: 'inherit' }); } catch (initErr) { console.error('Auto-init failed — run: npm run db:init'); }
  }
}

// ── Start server ───────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  ${(process.env.BRAND_NAME || 'Telehealth').padEnd(40)}    ║
  ║  Backend running on port ${String(PORT).padEnd(20)}    ║
  ║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(27)}    ║
  ╚══════════════════════════════════════════════╝
  `);
  await ensureTables();
});

module.exports = app;
