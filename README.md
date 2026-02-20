# Telehealth Backend — Shared Template

Stripe billing + MDI clinical integration backend for GLP-1 telehealth brands.
One codebase, multiple deployments. Each brand gets its own Render service + database.

## Architecture

```
Static Site (Netlify)  →  This Backend (Render)  →  Stripe (billing)
                                                 →  MDI (clinical/HIPAA)
                                                 →  PostgreSQL (billing data only)
```

**What this backend handles:** Customer accounts, Stripe subscriptions, payment webhooks, admin dashboard, order tracking.

**What this backend does NOT handle:** Medical intake, prescriptions, patient health data (all handled by MDI under their HIPAA compliance).

## Quick Start

```bash
# Install
npm install

# Set up env vars (copy .env.example to .env)
cp .env.example .env

# Initialize database
npm run db:init

# Seed admin account
npm run db:seed-admin

# Run
npm start
```

## Deploy on Render (per brand)

### 1. Create PostgreSQL Database
- Render → New → PostgreSQL
- Name: `glprx-db` (or `clyr-db`)
- Copy the Internal Database URL

### 2. Create Web Service
- Render → New → Web Service
- Connect your GitHub repo
- Build command: `npm install`
- Start command: `npm start`

### 3. Set Environment Variables
Copy all vars from `.env.example` and fill in:
- `DATABASE_URL` — from step 1
- `STRIPE_SECRET_KEY` — from Stripe dashboard
- `STRIPE_WEBHOOK_SECRET` — from Stripe webhook setup
- `MDI_INTAKE_URL` — from MDI partner portal
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your admin credentials
- `BRAND_NAME` / `BRAND_DOMAIN` — brand-specific

### 4. Set Up Stripe Webhook
- Stripe Dashboard → Developers → Webhooks
- Endpoint URL: `https://your-backend.onrender.com/api/webhooks/stripe`
- Events: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`

### 5. Create Stripe Products & Prices
Create subscription prices in Stripe and add their IDs to env vars.

### 6. Seed Admin Account
Visit: `https://your-backend.onrender.com/api/admin/seed`

### 7. Access Admin Dashboard
Visit: `https://your-backend.onrender.com/admin.html`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/products` | Public product listing |
| POST | `/api/checkout` | Create Stripe Checkout session |
| POST | `/api/customer-portal` | Open Stripe billing portal |
| GET | `/api/subscription-status` | Check subscription status |
| GET | `/api/intake-redirect` | Redirect to MDI intake |
| POST | `/api/webhooks/stripe` | Stripe webhook handler |
| POST | `/api/admin/login` | Admin login |
| GET | `/api/admin/dashboard` | Dashboard stats |
| GET | `/api/admin/customers` | Customer list |
| GET | `/api/admin/subscriptions` | Subscription list |
| GET | `/api/admin/orders` | Order list |
| POST | `/api/admin/cancel-subscription` | Cancel a subscription |
| POST | `/api/admin/update-order-status` | Update order/pharmacy status |
| GET | `/api/admin/revenue-chart` | Revenue chart data (30d) |

## Deploying for a Second Brand

1. Create a new Render Web Service + PostgreSQL
2. Point to the same GitHub repo
3. Set different env vars (brand name, domain, Stripe keys, MDI keys)
4. Set up brand-specific Stripe webhook
5. Seed admin: `/api/admin/seed`
6. Done — same code, different brand
