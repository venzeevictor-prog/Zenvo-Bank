# ZenvoBank — banking platform foundation + web console

Node.js (ES modules) · Express 5 · PostgreSQL via `pg` (no ORM) · Zod · Argon2id · plain HTML/CSS/JavaScript frontend.

## Current implementation

This repository contains a backend foundation and a connected web console. It is **not ready to hold or move real customer funds**.

| Area | Status |
|---|---|
| Database schema, migrations, configuration, health check, graceful shutdown | Implemented |
| Customer registration, email verification flow, login, sessions, CSRF, lockout, transaction PIN | Implemented; production email delivery not connected |
| Country → default currency, one initial account, test-money labelling | Implemented |
| Staff authentication + backend RBAC | Implemented; MFA is not implemented, so production staff login is blocked by design |
| Double-entry ledger, immutable postings, holds, reversals, idempotency | Implemented |
| Same-currency internal transfers with PIN step-up | Implemented |
| Staff credit/debit adjustments with reasons and approval workflow | Implemented |
| Admin customer search/detail, account restriction, ledger view, integrity report, audit logs | Implemented |
| Customer web UI: sign-in, signup, verification, overview, accounts, internal transfers, activity, PIN settings | Initial UI implemented and connected to API |
| Staff web UI: customer lookup, adjustment requests/approvals, ledger integrity | Initial UI implemented and connected to API |
| International transfers, FX quotes, beneficiaries, provider adapters, provider webhooks | Not implemented |
| KYC workflow/provider, phone verification, password reset, session management UI | Not implemented |
| Live support chat, real-time notifications, email/SMS delivery | Not implemented |
| Provider/bank reconciliation, transfer limits, velocity controls, sanctions screening | Not implemented |
| Production deployment and live payment-provider verification | Not tested/deployed |

## Run locally

Requirements: Node.js 20+ and PostgreSQL.

```bash
npm ci
cp .env.example .env
# Set DATABASE_URL in .env to your PostgreSQL database
npm run migrate
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' npm run create-admin
npm run dev
```

Open `http://localhost:3000`. The same Express server serves the frontend and API.

For tests, use a dedicated database whose name contains `test`. The reset script drops and recreates that database's `public` schema:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/zenvobank_test npm test
```

GitHub Actions CI runs JavaScript syntax checks and the PostgreSQL-backed test suite on relevant pushes and pull requests.

## API

Base path: `/api/v1`. JSON requests use cookie sessions. Authenticated writes require the `X-CSRF-Token` header and an appropriate CSRF cookie. Transfer/adjustment creation also requires an `Idempotency-Key`.

Public: `GET /countries`, `POST /auth/register`, `POST /auth/verify-email`, `POST /auth/login`.

Customer: `POST /auth/logout`, `GET /me`, `POST /me/pin`, `GET /accounts`, `GET /accounts/:id`, `GET /accounts/:id/transactions`, `GET /transactions/:reference`, `GET /transactions/:reference/receipt`, `GET /notifications`, `POST /transfers/internal/lookup`, `POST /transfers/internal`.

Staff: `POST /admin/auth/login`, `GET /admin/auth/me`, `GET /admin/customers`, `GET /admin/customers/:id`, `POST /admin/accounts/:id/status`, `GET /admin/ledger`, `GET /admin/reconciliation/ledger-integrity`, `GET|POST /admin/adjustments`, `POST /admin/adjustments/:id/approve|reject`, `GET /admin/audit-logs`.

## Financial safety model

- Balances are derived from ledger postings; there is no editable customer balance field.
- Every journal entry must balance, validated in code and by a deferred database constraint trigger.
- Ledger postings and journal entries are immutable. Corrections use compensating entries.
- Account rows are locked before spending paths re-check available funds.
- Idempotency keys prevent duplicate transfer and adjustment submissions.
- Non-production accounts are marked as test accounts; receipts should be treated as simulated funds.
- Staff adjustments use typed counter-accounts and configurable approval thresholds. With no configured limit row, an adjustment requires two distinct approvers.
- Provider references are not verified automatically yet. The existing internal ledger report is **not** external bank reconciliation.

## Deployment cautions

1. Configure PostgreSQL TLS and secrets before production.
2. Do not enable live money movement until regulated payment/FX partners, sanctions and fraud checks, transfer limits, reconciliation, incident handling, and compliance obligations are implemented and independently reviewed.
3. The enabled country list is starter data, not a legal decision about where the service may operate.
4. Production staff access requires MFA, which has not been implemented.
5. Railway/Aiven configuration has not been deployed or verified in a live environment.
