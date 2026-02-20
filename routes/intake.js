const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// ── POST /api/intake — Save intake form submission ─────────
router.post('/', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone,
      dobMonth, dobDay, dobYear, sex,
      heightFt, heightIn, weight,
      treatment,
      screeningClear, flaggedConditions,
      consents,
      address, apt, city, state, zip,
      visitor_id,
      utm_source, utm_medium, utm_campaign
    } = req.body;

    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: 'firstName, lastName, and email are required' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;

    // Parse DOB
    let dob = null;
    if (dobMonth && dobDay && dobYear) {
      const months = {
        'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
        'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12
      };
      const monthNum = months[dobMonth] || parseInt(dobMonth) || 1;
      dob = `${dobYear}-${String(monthNum).padStart(2, '0')}-${String(dobDay).padStart(2, '0')}`;
    }

    const emailClean = email.toLowerCase().trim();

    // Ensure columns exist (safe migration)
    const cols = [
      'dob DATE','sex VARCHAR(20)','height_ft INTEGER','height_in INTEGER','weight_lbs INTEGER',
      'shipping_apt VARCHAR(100)','treatment_product VARCHAR(50)',
      "intake_status VARCHAR(30) DEFAULT 'pending'",
      'screening_clear BOOLEAN DEFAULT FALSE','flagged_conditions TEXT[]','consents JSONB',
      'utm_source VARCHAR(255)','utm_medium VARCHAR(255)','utm_campaign VARCHAR(255)','visitor_id VARCHAR(255)'
    ];
    for (const col of cols) {
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    }

    // Ensure intake_submissions table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS intake_submissions (
        id SERIAL PRIMARY KEY, customer_id INTEGER, email VARCHAR(255) NOT NULL,
        first_name VARCHAR(100), last_name VARCHAR(100), phone VARCHAR(20),
        dob DATE, sex VARCHAR(20), height_ft INTEGER, height_in INTEGER, weight_lbs INTEGER,
        treatment_product VARCHAR(50), screening_clear BOOLEAN DEFAULT FALSE,
        flagged_conditions TEXT[], consents JSONB,
        shipping_street VARCHAR(255), shipping_apt VARCHAR(100), shipping_city VARCHAR(100),
        shipping_state VARCHAR(2), shipping_zip VARCHAR(10),
        ip_address VARCHAR(45), visitor_id VARCHAR(255),
        utm_source VARCHAR(255), utm_medium VARCHAR(255), utm_campaign VARCHAR(255),
        status VARCHAR(30) DEFAULT 'submitted', created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Prep flagged conditions as postgres array
    const flaggedArr = (flaggedConditions && Array.isArray(flaggedConditions) && flaggedConditions.length > 0)
      ? flaggedConditions : null;
    const consentsJson = consents ? JSON.stringify(consents) : null;

    // Upsert customer
    let customer = await pool.query('SELECT id FROM customers WHERE email = $1', [emailClean]);

    if (customer.rows.length === 0) {
      const result = await pool.query(
        `INSERT INTO customers (
          email, first_name, last_name, phone, dob, sex,
          height_ft, height_in, weight_lbs,
          shipping_street, shipping_apt, shipping_city, shipping_state, shipping_zip,
          treatment_product, intake_status, screening_clear, flagged_conditions, consents,
          visitor_id, utm_source, utm_medium, utm_campaign, role, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'customer',NOW())
        RETURNING id`,
        [
          emailClean, firstName, lastName, phone || null, dob, sex || null,
          parseInt(heightFt) || null, parseInt(heightIn) || null, parseInt(weight) || null,
          address || null, apt || null, city || null, state || null, zip || null,
          treatment || null, 'intake_completed', screeningClear || false,
          flaggedArr, consentsJson,
          visitor_id || null, utm_source || null, utm_medium || null, utm_campaign || null
        ]
      );
      customer = { rows: [result.rows[0]] };
    } else {
      await pool.query(
        `UPDATE customers SET
          first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
          phone = COALESCE($4, phone), dob = COALESCE($5, dob), sex = COALESCE($6, sex),
          height_ft = COALESCE($7, height_ft), height_in = COALESCE($8, height_in),
          weight_lbs = COALESCE($9, weight_lbs),
          shipping_street = COALESCE($10, shipping_street), shipping_apt = COALESCE($11, shipping_apt),
          shipping_city = COALESCE($12, shipping_city), shipping_state = COALESCE($13, shipping_state),
          shipping_zip = COALESCE($14, shipping_zip),
          treatment_product = COALESCE($15, treatment_product), intake_status = 'intake_completed',
          screening_clear = $16, flagged_conditions = COALESCE($17, flagged_conditions),
          consents = COALESCE($18, consents), visitor_id = COALESCE($19, visitor_id),
          utm_source = COALESCE($20, utm_source), utm_medium = COALESCE($21, utm_medium),
          utm_campaign = COALESCE($22, utm_campaign), updated_at = NOW()
        WHERE id = $1`,
        [
          customer.rows[0].id,
          firstName, lastName, phone || null, dob, sex || null,
          parseInt(heightFt) || null, parseInt(heightIn) || null, parseInt(weight) || null,
          address || null, apt || null, city || null, state || null, zip || null,
          treatment || null, screeningClear || false,
          flaggedArr, consentsJson,
          visitor_id || null, utm_source || null, utm_medium || null, utm_campaign || null
        ]
      );
    }

    const customerId = customer.rows[0].id;

    // Audit trail
    await pool.query(
      `INSERT INTO intake_submissions (
        customer_id, email, first_name, last_name, phone, dob, sex,
        height_ft, height_in, weight_lbs, treatment_product,
        screening_clear, flagged_conditions, consents,
        shipping_street, shipping_apt, shipping_city, shipping_state, shipping_zip,
        ip_address, visitor_id, utm_source, utm_medium, utm_campaign, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'submitted')`,
      [
        customerId, emailClean, firstName, lastName, phone || null,
        dob, sex || null, parseInt(heightFt) || null, parseInt(heightIn) || null, parseInt(weight) || null,
        treatment || null, screeningClear || false, flaggedArr, consentsJson,
        address || null, apt || null, city || null, state || null, zip || null,
        ip, visitor_id || null, utm_source || null, utm_medium || null, utm_campaign || null
      ]
    ).catch(e => console.error('Intake audit log error:', e.message));

    // Track funnel event
    await pool.query(
      `INSERT INTO funnel_events (visitor_id, event_type, metadata, created_at) VALUES ($1, 'intake_completed', $2, NOW())`,
      [visitor_id || 'email-' + emailClean, JSON.stringify({ email: emailClean, treatment, customerId })]
    ).catch(() => {});

    console.log('Intake saved for customer:', customerId, emailClean);

    res.json({ success: true, customerId, message: 'Intake submitted successfully' });
  } catch (err) {
    console.error('Intake error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to save intake data', detail: err.message });
  }
});

module.exports = router;
