const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── Stripe Webhook Handler ─────────────────────────────────
// This route receives raw body (configured in server.js)
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Idempotency check — don't process the same event twice
  try {
    const existing = await pool.query(
      'SELECT id FROM webhook_events WHERE stripe_event_id = $1',
      [event.id]
    );
    if (existing.rows.length > 0) {
      return res.json({ received: true, duplicate: true });
    }

    // Log the event
    await pool.query(
      `INSERT INTO webhook_events (stripe_event_id, event_type, payload)
       VALUES ($1, $2, $3)`,
      [event.id, event.type, JSON.stringify(event.data)]
    );
  } catch (err) {
    console.error('Webhook logging error:', err);
  }

  // Process by event type
  try {
    switch (event.type) {

      // ── Checkout completed — new subscription ────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const meta = session.metadata || {};
        const customerId = parseInt(meta.db_customer_id);

        if (session.mode === 'subscription' && customerId) {
          // Get the Stripe subscription details
          const stripeSub = await stripe.subscriptions.retrieve(session.subscription);

          // Update customer with Stripe ID if not set
          if (session.customer) {
            await pool.query(
              'UPDATE customers SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL',
              [session.customer, customerId]
            );
          }

          // Save shipping address if collected
          if (session.shipping_details?.address) {
            const addr = session.shipping_details.address;
            await pool.query(
              `UPDATE customers
               SET shipping_street = $1, shipping_city = $2, shipping_state = $3, shipping_zip = $4, updated_at = NOW()
               WHERE id = $5`,
              [addr.line1 + (addr.line2 ? ' ' + addr.line2 : ''), addr.city, addr.state, addr.postal_code, customerId]
            );
          }

          // Create subscription record
          const priceItem = stripeSub.items.data[0];
          await pool.query(
            `INSERT INTO subscriptions
             (customer_id, stripe_subscription_id, stripe_price_id, product_type, plan_type, status, amount_cents, current_period_start, current_period_end)
             VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($9))
             ON CONFLICT (stripe_subscription_id) DO UPDATE SET
               status = EXCLUDED.status,
               current_period_start = EXCLUDED.current_period_start,
               current_period_end = EXCLUDED.current_period_end,
               updated_at = NOW()`,
            [
              customerId,
              stripeSub.id,
              priceItem.price.id,
              meta.product_type || 'unknown',
              meta.plan_type || 'monthly',
              stripeSub.status,
              priceItem.price.unit_amount || 0,
              stripeSub.current_period_start,
              stripeSub.current_period_end
            ]
          );

          // Create initial order record
          await pool.query(
            `INSERT INTO orders (customer_id, subscription_id, stripe_payment_intent_id, amount_cents, status, product_type)
             VALUES ($1, (SELECT id FROM subscriptions WHERE stripe_subscription_id = $2), $3, $4, 'paid', $5)`,
            [
              customerId,
              stripeSub.id,
              session.payment_intent,
              priceItem.price.unit_amount || 0,
              meta.product_type || 'unknown'
            ]
          );

          console.log(`✓ New subscription: customer=${customerId} product=${meta.product_type} plan=${meta.plan_type}`);
        }
        break;
      }

      // ── Subscription updated (renewal, plan change) ──
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await pool.query(
          `UPDATE subscriptions
           SET status = $1,
               current_period_start = to_timestamp($2),
               current_period_end = to_timestamp($3),
               cancel_at = $4,
               updated_at = NOW()
           WHERE stripe_subscription_id = $5`,
          [
            sub.status,
            sub.current_period_start,
            sub.current_period_end,
            sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
            sub.id
          ]
        );
        console.log(`✓ Subscription updated: ${sub.id} → ${sub.status}`);
        break;
      }

      // ── Subscription canceled ────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await pool.query(
          `UPDATE subscriptions
           SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        console.log(`✓ Subscription canceled: ${sub.id}`);
        break;
      }

      // ── Invoice paid (recurring payment success) ─────
      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          // Find customer from subscription
          const subResult = await pool.query(
            'SELECT customer_id, id FROM subscriptions WHERE stripe_subscription_id = $1',
            [invoice.subscription]
          );
          if (subResult.rows.length > 0) {
            const { customer_id, id: subId } = subResult.rows[0];
            await pool.query(
              `INSERT INTO orders (customer_id, subscription_id, stripe_invoice_id, stripe_payment_intent_id, amount_cents, status, product_type)
               VALUES ($1, $2, $3, $4, $5, 'paid',
                 (SELECT product_type FROM subscriptions WHERE id = $2))`,
              [customer_id, subId, invoice.id, invoice.payment_intent, invoice.amount_paid]
            );
            console.log(`✓ Invoice paid: ${invoice.id} amount=${invoice.amount_paid}`);
          }
        }
        break;
      }

      // ── Invoice payment failed ───────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await pool.query(
            `UPDATE subscriptions SET status = 'past_due', updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [invoice.subscription]
          );
          console.log(`⚠ Payment failed: subscription=${invoice.subscription}`);
          // TODO: trigger email notification to customer
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Mark as processed
    await pool.query(
      'UPDATE webhook_events SET processed = true WHERE stripe_event_id = $1',
      [event.id]
    );

  } catch (err) {
    console.error(`Error processing ${event.type}:`, err);
  }

  res.json({ received: true });
});

module.exports = router;
