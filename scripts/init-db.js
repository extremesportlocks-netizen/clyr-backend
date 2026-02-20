require('dotenv').config();
const pool = require('../config/database');

const schema = `
-- ============================================================
-- TELEHEALTH BACKEND SCHEMA
-- Handles: billing, subscriptions, customer accounts, admin
-- Does NOT store: PHI, medical records, intake data (that's MDI)
-- ============================================================

-- Customers (billing identity only — no medical data)
CREATE TABLE IF NOT EXISTS customers (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255) UNIQUE NOT NULL,
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  phone           VARCHAR(20),
  shipping_street  VARCHAR(255),
  shipping_city    VARCHAR(100),
  shipping_state   VARCHAR(2),
  shipping_zip     VARCHAR(10),
  stripe_customer_id VARCHAR(255) UNIQUE,
  mdi_patient_id   VARCHAR(255),
  role            VARCHAR(20) DEFAULT 'customer',
  password_hash   VARCHAR(255),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions (linked to Stripe subscriptions)
CREATE TABLE IF NOT EXISTS subscriptions (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE,
  stripe_price_id VARCHAR(255),
  product_type    VARCHAR(50) NOT NULL,       -- 'tirzepatide', 'semaglutide', 'tirz_micro', 'sema_micro'
  plan_type       VARCHAR(20) NOT NULL,       -- 'monthly', '3month'
  status          VARCHAR(30) DEFAULT 'pending', -- 'active', 'past_due', 'canceled', 'paused', 'pending'
  amount_cents    INTEGER NOT NULL,
  currency        VARCHAR(3) DEFAULT 'usd',
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at       TIMESTAMPTZ,
  canceled_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Orders (individual billing cycles / fulfillment tracking)
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  stripe_invoice_id VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  amount_cents    INTEGER NOT NULL,
  status          VARCHAR(30) DEFAULT 'pending', -- 'pending', 'paid', 'fulfilled', 'shipped', 'delivered', 'refunded'
  product_type    VARCHAR(50),
  mdi_encounter_id VARCHAR(255),                 -- links to MDI encounter (no PHI stored)
  pharmacy_status  VARCHAR(30),                   -- 'pending', 'processing', 'shipped', 'delivered'
  tracking_number  VARCHAR(255),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook events log (idempotency + audit trail)
CREATE TABLE IF NOT EXISTS webhook_events (
  id              SERIAL PRIMARY KEY,
  stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type      VARCHAR(100) NOT NULL,
  processed       BOOLEAN DEFAULT FALSE,
  payload         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Admin activity log
CREATE TABLE IF NOT EXISTS admin_activity (
  id              SERIAL PRIMARY KEY,
  admin_id        INTEGER REFERENCES customers(id),
  action          VARCHAR(100) NOT NULL,
  target_type     VARCHAR(50),
  target_id       INTEGER,
  details         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Page views / analytics tracking
CREATE TABLE IF NOT EXISTS page_views (
  id              SERIAL PRIMARY KEY,
  visitor_id      VARCHAR(255) NOT NULL,
  page_path       VARCHAR(500) NOT NULL,
  referrer        VARCHAR(500),
  viewed_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_stripe ON webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_id);
CREATE INDEX IF NOT EXISTS idx_page_views_time ON page_views(viewed_at);
CREATE INDEX IF NOT EXISTS idx_page_views_page ON page_views(page_path);
`;

async function initDB() {
  try {
    console.log('Initializing database schema...');
    await pool.query(schema);
    console.log('✓ Database schema created successfully');
    process.exit(0);
  } catch (err) {
    console.error('✗ Database initialization failed:', err.message);
    process.exit(1);
  }
}

initDB();
