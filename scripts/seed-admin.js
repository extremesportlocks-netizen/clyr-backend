require('dotenv').config();
const pool = require('../config/database');
const bcrypt = require('bcryptjs');

async function seedAdmin() {
  try {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;

    if (!email || !password) {
      console.error('✗ ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment');
      process.exit(1);
    }

    // Check if admin already exists
    const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      console.log('✓ Admin account already exists');
      process.exit(0);
    }

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO customers (email, first_name, role, password_hash)
       VALUES ($1, $2, 'admin', $3)`,
      [email, 'Admin', hash]
    );

    console.log(`✓ Admin account created: ${email}`);
    process.exit(0);
  } catch (err) {
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
  }
}

seedAdmin();
