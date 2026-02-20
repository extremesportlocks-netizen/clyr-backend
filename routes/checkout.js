const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// Initialize Stripe (key comes from env)
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// ── Price map from env ─────────────────────────────────────
function getPriceId(productType, planType) {
  const map = {
    'tirzepatide_monthly':    process.env.STRIPE_PRICE_TIRZ_MONTHLY,
    'tirzepatide_3month':     process.env.STRIPE_PRICE_TIRZ_3MONTH,
    'tirzepatide_6month':     process.env.STRIPE_PRICE_TIRZ_6MONTH,
    'semaglutide_monthly':    process.env.STRIPE_PRICE_SEMA_MONTHLY,
    'semaglutide_3month':     process.env.STRIPE_PRICE_SEMA_3MONTH,
    'semaglutide_6month':     process.env.STRIPE_PRICE_SEMA_6MONTH,
  };
  return map[`${productType}_${planType}`];
}

// ── GET /api/products — Public product listing ─────────────
router.get('/products', (req, res) => {
  res.json({
    brand: process.env.BRAND_NAME || 'CLYR Health',
    products: [
      {
        id: 'semaglutide',
        name: 'Compounded Semaglutide + B12',
        type: 'GLP-1 Agonist',
        description: 'Targets the GLP-1 receptor for proven weight loss results',
        avgWeightLoss: '13-15%',
        includes: 'Provider consultation, prescription, medication, supplies, free shipping',
        plans: [
          { type: 'monthly', price: 29900, label: '$299/mo' },
          { type: '3month', price: 24900, label: '$249/mo', savings: 'Save $150', billedAs: '$747 quarterly' },
          { type: '6month', price: 19900, label: '$199/mo', savings: 'Save $600', billedAs: '$1,194 semi-annually' }
        ]
      },
      {
        id: 'tirzepatide',
        name: 'Compounded Tirzepatide + B12',
        type: 'GLP-1/GIP Dual Agonist',
        description: 'Works on both GLP-1 and GIP receptors for maximum weight loss',
        avgWeightLoss: '20-21%',
        includes: 'Provider consultation, prescription, medication, supplies, free shipping',
        plans: [
          { type: 'monthly', price: 39900, label: '$399/mo' },
          { type: '3month', price: 34900, label: '$349/mo', savings: 'Save $150', billedAs: '$1,047 quarterly' },
          { type: '6month', price: 29900, label: '$299/mo', savings: 'Save $600', billedAs: '$1,794 semi-annually' }
        ]
      }
    ]
  });
});

// ── POST /api/checkout — Create Stripe Checkout Session ────
router.post('/checkout', async (req, res) => {
  try {
    const { email, productType, planType, firstName, lastName } = req.body;

    if (!email || !productType || !planType) {
      return res.status(400).json({ error: 'email, productType, and planType are required' });
    }

    const priceId = getPriceId(productType, planType);
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid product or plan selection' });
    }

    // Find or create customer in our DB
    let customer = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);

    if (customer.rows.length === 0) {
      const result = await pool.query(
        `INSERT INTO customers (email, first_name, last_name) VALUES ($1, $2, $3) RETURNING *`,
        [email, firstName || null, lastName || null]
      );
      customer = { rows: [result.rows[0]] };
    }

    const dbCustomer = customer.rows[0];

    // Find or create Stripe customer
    let stripeCustomerId = dbCustomer.stripe_customer_id;
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({
        email: email,
        name: [firstName, lastName].filter(Boolean).join(' ') || undefined,
        metadata: {
          brand: process.env.BRAND_NAME,
          db_customer_id: dbCustomer.id.toString()
        }
      });
      stripeCustomerId = stripeCustomer.id;

      await pool.query(
        'UPDATE customers SET stripe_customer_id = $1 WHERE id = $2',
        [stripeCustomerId, dbCustomer.id]
      );
    }

    // Determine if this is a one-time or recurring
    const isBundle = planType === '3month';

    // Create Checkout Session
    const sessionConfig = {
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.BRAND_DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BRAND_DOMAIN}/#products`,
      metadata: {
        product_type: productType,
        plan_type: planType,
        db_customer_id: dbCustomer.id.toString(),
        brand: process.env.BRAND_NAME
      },
      subscription_data: {
        metadata: {
          product_type: productType,
          plan_type: planType,
          db_customer_id: dbCustomer.id.toString()
        }
      },
      // Collect shipping address for medication delivery
      shipping_address_collection: {
        allowed_countries: ['US']
      },
      // Allow promo codes if configured
      allow_promotion_codes: true
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── POST /api/customer-portal — Stripe Customer Portal ─────
router.post('/customer-portal', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const customer = await pool.query(
      'SELECT stripe_customer_id FROM customers WHERE email = $1',
      [email]
    );
    if (!customer.rows.length || !customer.rows[0].stripe_customer_id) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.rows[0].stripe_customer_id,
      return_url: process.env.BRAND_DOMAIN
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// ── GET /api/subscription-status — Check subscription ──────
router.get('/subscription-status', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const result = await pool.query(
      `SELECT s.*, c.email, c.first_name, c.last_name
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       WHERE c.email = $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [email]
    );

    if (!result.rows.length) {
      return res.json({ active: false });
    }

    const sub = result.rows[0];
    res.json({
      active: sub.status === 'active',
      status: sub.status,
      productType: sub.product_type,
      planType: sub.plan_type,
      currentPeriodEnd: sub.current_period_end,
      cancelAt: sub.cancel_at
    });
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({ error: 'Failed to check subscription' });
  }
});

module.exports = router;
