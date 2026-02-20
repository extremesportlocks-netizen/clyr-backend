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
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
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

// ── Static files (admin dashboard) ─────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ─────────────────────────────────────────────────
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/admin');

app.use('/api', checkoutRoutes);
app.use('/api/admin', adminRoutes);

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    brand: process.env.BRAND_NAME || 'Telehealth Backend',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's'
  });
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
  } catch (err) {
    console.log('Initializing database tables...');
    const { execSync } = require('child_process');
    try {
      execSync('node scripts/init-db.js', { stdio: 'inherit' });
    } catch (initErr) {
      console.error('Auto-init failed — run: npm run db:init');
    }
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
