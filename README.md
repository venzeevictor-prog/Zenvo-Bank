# ZenvoBank — foundation, ledger and accounting (build pass 1)

Node.js (ES modules) · Express 5 · PostgreSQL via `pg` (no ORM) · Zod · Argon2id. Frontend will be vanilla HTML/CSS/JS.

This pass implements the parts everything else depends on: schema and migrations, authentication, RBAC, the
double-entry ledger, internal transfers and the controlled accountant credit/debit workflow with approvals.
**It is a backend only: there is no customer or admin UI yet, and no real-money capability.**

## Status against the specification

| Area | Status |
|---|---|
| Migrations, config, logging, health check, graceful shutdown | Done |
| Customer auth: register, email verify, login, sessions, CSRF, lockout, transaction PIN | Done (email delivery not connected; dev returns the token in the response) |
| Country → default currency, account per currency, test-money labelling | Done (one account in the default currency is opened at registration) |
| Staff auth + backend RBAC (9 roles, 13 permissions) | Done. **MFA not implemented** → staff login is blocked in production by design |
| Double-entry ledger, immutability, holds, reversals, idempotency | Done, enforced in the database as well as in code |
| Internal transfers (same currency) with PIN step-up | Done |
| Accountant adjustments: reasons, limits, 0/1/2-approver workflow, no self-approval | Done |
| Admin API: customer search/detail, account restrict, ledger view, integrity report, audit logs | Done |
| Phone verification, password reset, KYC, session management UI | **Not started** |
| Customer + admin + accountant web UI | **Not started** |
| FX quotes, beneficiaries, international transfers, provider adapters, webhooks | **Not started** |
| Live support chat (Socket.IO) | **Not started** |
| Reconciliation against providers, CSV reports, notifications by email | **Not started** (internal ledger integrity report exists) |

## Run it

```bash
npm install
cp .env.example .env            # set DATABASE_URL
npm run migrate
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' npm run create-admin   # once; refuses if an admin exists
npm run dev
```

## Tests

```bash
# needs a PostgreSQL database whose name contains "test"; the script DROPS and recreates its public schema
DATABASE_URL=postgres://postgres:postgres@localhost:5432/zenvobank_test npm test
```
Last run: **45 passing, 0 failing** (unit, ledger invariants, auth, transfers, accounting, access control).
I also deliberately broke three safeguards (row locks, self-approval check, balance trigger) and confirmed the
relevant tests fail, so they are not vacuous.

## How the money works

* **No balance column exists.** Balance = sum of ledger postings on the customer's liability ledger account; available = balance − active holds.
* Every journal entry must balance. Checked in JS (BigInt) and by a deferred constraint trigger at COMMIT. Postings must match the entry and account currency and the currency's decimal places.
* `ledger_postings`, `journal_entries` and `audit_logs` reject UPDATE/DELETE/TRUNCATE; `financial_transactions` can only change status/metadata. Corrections are compensating entries (`reverseTransaction`).
* Spending paths lock the account row (`FOR UPDATE`, deterministic order), re-check available funds, then post; a post-insert check refuses any entry that would leave a customer negative.
* Idempotency: transfers use `(user, Idempotency-Key)`; adjustments use `(staff, Idempotency-Key)`; reuse with a different body is a 409.
* Adjustments post against a typed counter-account (settlement, refunds, corrections, promo, fees). Thresholds live in `adjustment_limits`; **with no row, every adjustment needs two distinct approvers**. Promotional credits are off until enabled in `application_settings`.
* Outside production every account is flagged `is_test` and receipts say "TEST TRANSACTION". Test and live accounts cannot transact with each other.

## Known gaps and honest caveats

1. `external_reference_verified` is always false: a deposit adjustment records a staff-entered provider/bank reference but nothing verifies it yet. Treat these as manually attested until a provider adapter exists.
2. No transfer limits / velocity / sanctions checks yet; do not enable real money without them.
3. Registration returns 409 for an existing email (account enumeration trade-off); revisit when email delivery exists.
4. Balance queries sum postings on the fly. Fine for now; add a reconciled projection before volume grows.
5. `railway.json` and the Aiven TLS settings are written to documented conventions but **have not been deployed or tested**.
6. The seeded country onboarding flags (NG, US, GB, GH, KE, CA enabled) are placeholders, not a legal/compliance decision.

## API (all under `/api/v1`, JSON, cookie sessions + `X-CSRF-Token` header for writes)

Public: `GET /countries`, `POST /auth/register|verify-email|login`
Customer: `POST /auth/logout`, `GET /me`, `POST /me/pin`, `GET /accounts`, `GET /accounts/:id`, `GET /accounts/:id/transactions`,
`GET /transactions/:reference`, `GET /transactions/:reference/receipt[?format=html]`, `GET /notifications`,
`POST /transfers/internal/lookup`, `POST /transfers/internal` (needs `Idempotency-Key` + PIN)
Staff (`/admin/...`): `POST /auth/login|logout`, `GET /auth/me`, `GET /customers?q=`, `GET /customers/:id`, `POST /accounts/:id/status`,
`GET /ledger`, `GET /reconciliation/ledger-integrity`, `GET /adjustment-reasons`, `POST|GET /adjustments`, `GET /adjustments/:id`,
`POST /adjustments/:id/approve|reject`, `PUT /adjustment-limits/:currency`, `GET /audit-logs`

Errors: `{ "error": { "code", "message", "details?" } }`.

## Layout

`src/{config,database,middleware,modules/{auth,accounts,ledger,accounting,transfers,admin},services,utils}`, `scripts/`, `tests/{unit,integration,security}`.
Schema: `src/database/migrations/001_init.sql` (commented). Deployment: run `npm run migrate` as a pre-deploy step, never on app start.
