-- ZenvoBank foundation schema: identity, staff RBAC, double-entry ledger, accounting adjustments.
-- All timestamps are UTC (timestamptz). Amounts are NUMERIC(28,8) with per-currency scale enforced by trigger.

-- ---------- Reference data ----------
CREATE TABLE currencies (
  code        char(3) PRIMARY KEY,
  name        text NOT NULL,
  symbol      text NOT NULL,
  decimals    smallint NOT NULL CHECK (decimals BETWEEN 0 AND 8),
  enabled     boolean NOT NULL DEFAULT true
);

CREATE TABLE countries (
  code                text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  name                text NOT NULL,
  calling_code        text NOT NULL,
  default_currency    char(3) NOT NULL REFERENCES currencies(code),
  onboarding_enabled  boolean NOT NULL DEFAULT false
);

-- ---------- Identity ----------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'pending_verification'
                     CHECK (status IN ('pending_verification','active','restricted','closed')),
  country_code       text NOT NULL REFERENCES countries(code),
  preferred_language text NOT NULL DEFAULT 'en',
  display_currency   char(3) NOT NULL REFERENCES currencies(code),
  phone              text,
  phone_verified_at  timestamptz,
  email_verified_at  timestamptz,
  kyc_status         text NOT NULL DEFAULT 'not_started'
                     CHECK (kyc_status IN ('not_started','pending','under_review','verified','rejected','requires_information','restricted')),
  tx_pin_hash        text,
  pin_failed_attempts integer NOT NULL DEFAULT 0,
  pin_locked_until   timestamptz,
  failed_logins      integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE user_profiles (
  user_id      uuid PRIMARY KEY REFERENCES users(id),
  full_name    text NOT NULL,
  nationality  text REFERENCES countries(code),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Staff and RBAC ----------
CREATE TABLE staff_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  full_name      text NOT NULL,
  password_hash  text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  mfa_enabled    boolean NOT NULL DEFAULT false,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_email_unique ON staff_users (lower(email));

CREATE TABLE roles (
  id    serial PRIMARY KEY,
  code  text NOT NULL UNIQUE,
  name  text NOT NULL
);
CREATE TABLE permissions (
  code         text PRIMARY KEY,
  description  text NOT NULL
);
CREATE TABLE role_permissions (
  role_id          integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);
CREATE TABLE staff_role_assignments (
  staff_id    uuid NOT NULL REFERENCES staff_users(id),
  role_id     integer NOT NULL REFERENCES roles(id),
  granted_by  uuid REFERENCES staff_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, role_id)
);

CREATE TABLE user_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('customer','staff')),
  user_id     uuid REFERENCES users(id),
  staff_id    uuid REFERENCES staff_users(id),
  token_hash  text NOT NULL UNIQUE,
  ip          text,
  user_agent  text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'customer' AND user_id IS NOT NULL AND staff_id IS NULL)
      OR (kind = 'staff' AND staff_id IS NOT NULL AND user_id IS NULL))
);

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  actor_type   text NOT NULL CHECK (actor_type IN ('customer','staff','system')),
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  ip           text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_type, actor_id, created_at DESC);

CREATE TABLE application_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO application_settings (key, value) VALUES ('promo_credits_enabled', 'false'::jsonb);

-- ---------- Ledger ----------
CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  currency    char(3) NOT NULL REFERENCES currencies(code),
  is_customer boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  public_identifier text NOT NULL UNIQUE,      -- internal ZenvoBank identifier, NOT a bank-issued account number
  currency          char(3) NOT NULL REFERENCES currencies(code),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','restricted','closed')),
  ledger_account_id uuid NOT NULL UNIQUE REFERENCES ledger_accounts(id),
  is_test           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_accounts_user_currency ON customer_accounts (user_id, currency) WHERE status <> 'closed';

CREATE TABLE financial_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             text NOT NULL UNIQUE,
  type                  text NOT NULL CHECK (type IN ('internal_transfer','adjustment_credit','adjustment_debit','reversal','hold_capture')),
  status                text NOT NULL CHECK (status IN ('pending','completed','failed','reversed')),
  currency              char(3) NOT NULL REFERENCES currencies(code),
  amount                numeric(28,8) NOT NULL CHECK (amount > 0),
  description           text NOT NULL,
  initiated_by_user_id  uuid REFERENCES users(id),
  initiated_by_staff_id uuid REFERENCES staff_users(id),
  from_account_id       uuid REFERENCES customer_accounts(id),
  to_account_id         uuid REFERENCES customer_accounts(id),
  reverses_transaction_id uuid REFERENCES financial_transactions(id),
  is_test               boolean NOT NULL DEFAULT false,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX financial_tx_one_reversal ON financial_transactions (reverses_transaction_id) WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX financial_tx_from_idx ON financial_transactions (from_account_id, created_at DESC);
CREATE INDEX financial_tx_to_idx ON financial_transactions (to_account_id, created_at DESC);

CREATE TABLE transaction_idempotency_keys (
  scope                    text NOT NULL,
  key                      text NOT NULL,
  request_hash             text NOT NULL,
  financial_transaction_id uuid REFERENCES financial_transactions(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE journal_entries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_transaction_id uuid NOT NULL REFERENCES financial_transactions(id),
  description              text NOT NULL,
  currency                 char(3) NOT NULL REFERENCES currencies(code),
  posted_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_tx_idx ON journal_entries (financial_transaction_id);

CREATE TABLE ledger_postings (
  id                bigserial PRIMARY KEY,
  journal_entry_id  uuid NOT NULL REFERENCES journal_entries(id),
  ledger_account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  direction         char(1) NOT NULL CHECK (direction IN ('D','C')),
  amount            numeric(28,8) NOT NULL CHECK (amount > 0),
  currency          char(3) NOT NULL REFERENCES currencies(code)
);
CREATE INDEX ledger_postings_account_idx ON ledger_postings (ledger_account_id, id);
CREATE INDEX ledger_postings_entry_idx ON ledger_postings (journal_entry_id);

CREATE TABLE account_holds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_account_id uuid NOT NULL REFERENCES customer_accounts(id),
  amount              numeric(28,8) NOT NULL CHECK (amount > 0),
  reason              text NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','captured')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz
);
CREATE INDEX account_holds_active_idx ON account_holds (customer_account_id) WHERE status = 'active';

-- ---------- Ledger integrity triggers ----------
CREATE FUNCTION ledger_posting_validate() RETURNS trigger AS $$
DECLARE je_ccy char(3); la_ccy char(3); dec smallint;
BEGIN
  SELECT currency INTO je_ccy FROM journal_entries WHERE id = NEW.journal_entry_id;
  SELECT currency INTO la_ccy FROM ledger_accounts WHERE id = NEW.ledger_account_id;
  IF je_ccy IS DISTINCT FROM NEW.currency OR la_ccy IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'posting currency mismatch (entry %, account %, posting %)', je_ccy, la_ccy, NEW.currency;
  END IF;
  SELECT decimals INTO dec FROM currencies WHERE code = NEW.currency;
  IF NEW.amount <> round(NEW.amount, dec) THEN
    RAISE EXCEPTION 'amount % exceeds % decimal places for %', NEW.amount, dec, NEW.currency;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_posting_validate_trg BEFORE INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_posting_validate();

CREATE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
DECLARE d numeric; c numeric; n integer;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0),
         COUNT(*)
    INTO d, c, n FROM ledger_postings WHERE journal_entry_id = NEW.journal_entry_id;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'journal entry % is not balanced (debits %, credits %, postings %)', NEW.journal_entry_id, d, c, n;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_entry_balanced_trg AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: posted financial records are immutable', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_postings_immutable BEFORE UPDATE OR DELETE ON ledger_postings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_truncate_blocked BEFORE TRUNCATE ON ledger_postings FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION financial_tx_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'financial transactions cannot be deleted';
  END IF;
  IF NEW.reference <> OLD.reference OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
     OR NEW.type <> OLD.type OR NEW.from_account_id IS DISTINCT FROM OLD.from_account_id
     OR NEW.to_account_id IS DISTINCT FROM OLD.to_account_id THEN
    RAISE EXCEPTION 'financial transaction core fields are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER financial_tx_guard_trg BEFORE UPDATE OR DELETE ON financial_transactions FOR EACH ROW EXECUTE FUNCTION financial_tx_guard();

-- ---------- Accounting adjustments ----------
CREATE TABLE adjustment_reasons (
  code                        text PRIMARY KEY,
  name                        text NOT NULL,
  direction                   text NOT NULL CHECK (direction IN ('credit','debit')),
  counter_role                text NOT NULL CHECK (counter_role IN ('SETTLEMENT','REFUNDS','CORRECTIONS','PROMO','FEES')),
  requires_external_reference boolean NOT NULL DEFAULT false,
  enabled                     boolean NOT NULL DEFAULT true
);
INSERT INTO adjustment_reasons (code, name, direction, counter_role, requires_external_reference) VALUES
  ('DEPOSIT_CONFIRMED',   'Verified customer deposit',        'credit', 'SETTLEMENT',  true),
  ('REFUND',              'Refund to customer',               'credit', 'REFUNDS',     true),
  ('CORRECTION_CREDIT',   'Accounting correction (credit)',   'credit', 'CORRECTIONS', false),
  ('PROMOTIONAL_CREDIT',  'Promotional credit',               'credit', 'PROMO',       false),
  ('WITHDRAWAL_CONFIRMED','Confirmed external withdrawal',    'debit',  'SETTLEMENT',  true),
  ('CORRECTION_DEBIT',    'Accounting correction (debit)',    'debit',  'CORRECTIONS', false),
  ('FEE_CHARGE',          'Fee charge',                       'debit',  'FEES',        false);

-- Per-currency thresholds. No row => both limits 0: every adjustment needs two distinct approvers.
CREATE TABLE adjustment_limits (
  currency            char(3) PRIMARY KEY REFERENCES currencies(code),
  auto_post_limit     numeric(28,8) NOT NULL DEFAULT 0 CHECK (auto_post_limit >= 0),
  dual_approval_limit numeric(28,8) NOT NULL DEFAULT 0 CHECK (dual_approval_limit >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_adjustments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                   text NOT NULL UNIQUE,
  customer_account_id         uuid NOT NULL REFERENCES customer_accounts(id),
  direction                   text NOT NULL CHECK (direction IN ('credit','debit')),
  amount                      numeric(28,8) NOT NULL CHECK (amount > 0),
  currency                    char(3) NOT NULL REFERENCES currencies(code),
  reason_code                 text NOT NULL REFERENCES adjustment_reasons(code),
  explanation                 text NOT NULL CHECK (length(explanation) >= 10),
  internal_reference          text NOT NULL,
  external_reference          text,
  external_reference_verified boolean NOT NULL DEFAULT false,
  evidence_ref                text,
  is_test                     boolean NOT NULL DEFAULT false,
  status                      text NOT NULL CHECK (status IN ('pending_approval','posted','rejected')),
  approvals_required          smallint NOT NULL CHECK (approvals_required BETWEEN 0 AND 2),
  initiated_by                uuid NOT NULL REFERENCES staff_users(id),
  financial_transaction_id    uuid REFERENCES financial_transactions(id),
  rejection_reason            text,
  idempotency_key             text NOT NULL,
  request_hash                text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  decided_at                  timestamptz,
  UNIQUE (initiated_by, idempotency_key)
);
CREATE INDEX account_adjustments_status_idx ON account_adjustments (status, created_at DESC);

CREATE TABLE adjustment_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL REFERENCES account_adjustments(id),
  staff_id      uuid NOT NULL REFERENCES staff_users(id),
  decision      text NOT NULL CHECK (decision IN ('approved','rejected')),
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adjustment_id, staff_id)
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ---------- Seed reference data (configurable; onboarding flags are product decisions) ----------
INSERT INTO currencies (code, name, symbol, decimals) VALUES
  ('NGN','Nigerian Naira','₦',2), ('USD','US Dollar','$',2), ('GBP','Pound Sterling','£',2),
  ('EUR','Euro','€',2), ('GHS','Ghanaian Cedi','GH₵',2), ('KES','Kenyan Shilling','KSh',2),
  ('CAD','Canadian Dollar','C$',2), ('JPY','Japanese Yen','¥',0);

INSERT INTO countries (code, name, calling_code, default_currency, onboarding_enabled) VALUES
  ('NG','Nigeria','+234','NGN',true), ('US','United States','+1','USD',true),
  ('GB','United Kingdom','+44','GBP',true), ('GH','Ghana','+233','GHS',true),
  ('KE','Kenya','+254','KES',true), ('CA','Canada','+1','CAD',true),
  ('DE','Germany','+49','EUR',false), ('FR','France','+33','EUR',false),
  ('IE','Ireland','+353','EUR',false), ('NL','Netherlands','+31','EUR',false),
  ('JP','Japan','+81','JPY',false);

INSERT INTO permissions (code, description) VALUES
  ('customers.read','View customer profiles and accounts'),
  ('accounts.restrict','Restrict or reactivate customer accounts'),
  ('ledger.read','View ledger postings'),
  ('adjustments.read','View accounting adjustments'),
  ('adjustments.create','Request accounting adjustments'),
  ('adjustments.post_small','Self-post adjustments under the auto-post limit'),
  ('adjustments.approve','Approve or reject accounting adjustments'),
  ('reconciliation.read','View reconciliation and integrity reports'),
  ('reports.read','View and export financial reports'),
  ('audit.read','View audit logs'),
  ('settings.manage','Manage application settings and limits'),
  ('staff.manage','Manage staff and role assignments'),
  ('support.respond','Respond to customer support conversations');

INSERT INTO roles (code, name) VALUES
  ('super_admin','Super Admin'), ('operations_admin','Operations Administrator'),
  ('accountant','Accountant'), ('accounting_approver','Accounting Approver'),
  ('support_agent','Customer Support Agent'), ('support_supervisor','Support Supervisor'),
  ('compliance_officer','Compliance Officer'), ('fraud_analyst','Fraud Analyst'),
  ('auditor','Read-Only Auditor');

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p WHERE r.code = 'super_admin';
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x.p FROM roles r JOIN (VALUES
  ('operations_admin','customers.read'),('operations_admin','accounts.restrict'),('operations_admin','ledger.read'),
  ('operations_admin','adjustments.read'),('operations_admin','reconciliation.read'),('operations_admin','reports.read'),
  ('accountant','customers.read'),('accountant','ledger.read'),('accountant','adjustments.read'),
  ('accountant','adjustments.create'),('accountant','adjustments.post_small'),('accountant','reconciliation.read'),('accountant','reports.read'),
  ('accounting_approver','customers.read'),('accounting_approver','ledger.read'),('accounting_approver','adjustments.read'),
  ('accounting_approver','adjustments.approve'),('accounting_approver','reconciliation.read'),
  ('support_agent','support.respond'),('support_supervisor','support.respond'),('support_supervisor','customers.read'),
  ('compliance_officer','customers.read'),('compliance_officer','accounts.restrict'),('compliance_officer','audit.read'),
  ('fraud_analyst','customers.read'),('fraud_analyst','accounts.restrict'),
  ('auditor','customers.read'),('auditor','ledger.read'),('auditor','adjustments.read'),('auditor','audit.read'),
  ('auditor','reconciliation.read'),('auditor','reports.read')
) AS x(role_code, p) ON x.role_code = r.code;
