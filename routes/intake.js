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

    // Upsert customer
    let customer = await pool.query('SELECT id FROM customers WHERE email = $1', [email.toLowerCase().trim()]);

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
          email.toLowerCase().trim(), firstName, lastName, phone || null, dob, sex || null,
          parseInt(heightFt) || null, parseInt(heightIn) || null, parseInt(weight) || null,
          address || null, apt || null, city || null, state || null, zip || null,
          treatment || null, 'intake_completed', screeningClear || false,
          flaggedConditions && flaggedConditions.length ? flaggedConditions : null,
          consents ? JSON.stringify(consents) : null,
          visitor_id || null, utm_source || null, utm_medium || null, utm_campaign || null
        ]
      );
      customer = { rows: [result.rows[0]] };
    } else {
      // Update existing customer with new intake data
      await pool.query(
        `UPDATE customers SET
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          phone = COALESCE($4, phone),
          dob = COALESCE($5, dob),
          sex = COALESCE($6, sex),
          height_ft = COALESCE($7, height_ft),
          height_in = COALESCE($8, height_in),
          weight_lbs = COALESCE($9, weight_lbs),
          shipping_street = COALESCE($10, shipping_street),
          shipping_apt = COALESCE($11, shipping_apt),
          shipping_city = COALESCE($12, shipping_city),
          shipping_state = COALESCE($13, shipping_state),
          shipping_zip = COALESCE($14, shipping_zip),
          treatment_product = COALESCE($15, treatment_product),
          intake_status = 'intake_completed',
          screening_clear = $16,
          flagged_conditions = COALESCE($17, flagged_conditions),
          consents = COALESCE($18, consents),
          visitor_id = COALESCE($19, visitor_id),
          utm_source = COALESCE($20, utm_source),
          utm_medium = COALESCE($21, utm_medium),
          utm_campaign = COALESCE($22, utm_campaign),
          updated_at = NOW()
        WHERE id = $1`,
        [
          customer.rows[0].id,
          firstName, lastName, phone || null, dob, sex || null,
          parseInt(heightFt) || null, parseInt(heightIn) || null, parseInt(weight) || null,
          address || null, apt || null, city || null, state || null, zip || null,
          treatment || null, screeningClear || false,
          flaggedConditions && flaggedConditions.length ? flaggedConditions : null,
          consents ? JSON.stringify(consents) : null,
          visitor_id || null, utm_source || null, utm_medium || null, utm_campaign || null
        ]
      );
    }

    const customerId = customer.rows[0].id;

    // Save intake submission audit trail
    await pool.query(
      `INSERT INTO intake_submissions (
        customer_id, email, first_name, last_name, phone, dob, sex,
        height_ft, height_in, weight_lbs, treatment_product,
        screening_clear, flagged_conditions, consents,
        shipping_street, shipping_apt, shipping_city, shipping_state, shipping_zip,
        ip_address, visitor_id, utm_source, utm_medium, utm_campaign, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'submitted')`,
      [
        customerId, email.toLowerCase().trim(), firstName, lastName, phone || null,
        dob, sex || null, parseInt(heightFt) || null, parseInt(heightIn) || null, parseInt(weight) || null,
        treatment || null, screeningClear || false,
        flaggedConditions && flaggedConditions.length ? flaggedConditions : null,
        consents ? JSON.stringify(consents) : null,
        address || null, apt || null, city || null, state || null, zip || null,
        ip, visitor_id || null, utm_source || null, utm_medium || null, utm_campaign || null
      ]
    ).catch(e => console.error('Intake audit log error:', e.message));

    // Track funnel event
    await pool.query(
      `INSERT INTO funnel_events (visitor_id, event_type, metadata, created_at) VALUES ($1, 'intake_completed', $2, NOW())`,
      [visitor_id || 'email-' + email, JSON.stringify({ email, treatment, customerId })]
    ).catch(() => {});

    res.json({
      success: true,
      customerId,
      message: 'Intake submitted successfully'
    });
  } catch (err) {
    console.error('Intake error:', err);
    res.status(500).json({ error: 'Failed to save intake data' });
  }
});

// ── GET /api/intake/submissions — Admin: list all submissions ──
router.get('/submissions', async (req, res) => {
  // Auth check
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET || 'clyr-jwt-secret-2026');
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM intake_submissions ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ submissions: result.rows });
  } catch (err) {
    console.error('Intake submissions error:', err);
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

module.exports = router;
