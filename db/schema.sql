-- Galaxy Panel schema (SQLite)
-- Mirrors the data model observed on the reference controller panel.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users
-- One table holds every tier. parent_id forms the reseller tree:
--   controller -> developer -> super_master_admin -> master_admin -> admin
--                  -> super_seller -> seller
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  password_encrypted TEXT,
  role          TEXT    NOT NULL CHECK (role IN
                  ('controller','developer','super_master_admin','master_admin',
                   'admin','super_seller','seller')),
  parent_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  due           REAL    NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  closed_at     TEXT,
  created_by    TEXT    NOT NULL DEFAULT 'system',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_parent ON users(parent_id);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);

-- ---------------------------------------------------------------- keys
-- The chain columns are denormalised on purpose: the reference keys table
-- exposes its lineage tiers as readable columns, so we store the lineage
-- instead of rebuilding it per query. One column per tier below the controller,
-- generated from the same table that drives src/config.js CHAIN_COLUMN.
CREATE TABLE IF NOT EXISTS keys (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  key_name               TEXT    NOT NULL UNIQUE,
  client_name            TEXT    NOT NULL DEFAULT '',
  mac                    TEXT    NOT NULL DEFAULT '',
  ips                    TEXT    NOT NULL DEFAULT '',
  developer_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  super_master_admin_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  master_admin_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  super_seller_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  seller_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  days                   INTEGER NOT NULL DEFAULT 1,
  start_date             TEXT    NOT NULL,
  expire_date            TEXT    NOT NULL,
  has_paid               INTEGER NOT NULL DEFAULT 0,
  -- A gift key is handed to a seller by the controller, free of charge and
  -- already Paid. It is a normal key with this flag set, so no bill is ever
  -- raised for it and only the controller manages it.
  is_gift                INTEGER NOT NULL DEFAULT 0,
  renew_pending          INTEGER NOT NULL DEFAULT 0,
  -- Pair limits the client software fetches from /api/limits; the controller
  -- raises or lowers them per key on /pair_limits.
  limit_total            INTEGER NOT NULL DEFAULT 2,
  limit_app              INTEGER NOT NULL DEFAULT 2,
  limit_beta             INTEGER NOT NULL DEFAULT 1,
  type                   TEXT    NOT NULL DEFAULT 'normal' CHECK (type IN ('normal','demo')),
  status                 TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactive')),
  created_at             TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_keys_created_by ON keys(created_by_id);
CREATE INDEX IF NOT EXISTS idx_keys_super_seller ON keys(super_seller_id);
CREATE INDEX IF NOT EXISTS idx_keys_seller     ON keys(seller_id);
CREATE INDEX IF NOT EXISTS idx_keys_expire     ON keys(expire_date);

-- ---------------------------------------------------------------- role prices
-- /set_price : one row per role, price + daily panel-close hour (IST).
CREATE TABLE IF NOT EXISTS role_prices (
  role         TEXT PRIMARY KEY CHECK (role IN
                 ('controller','developer','super_master_admin','master_admin',
                  'admin','super_seller','seller')),
  price        REAL    NOT NULL DEFAULT 0,
  cutoff_hour  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- payments
-- Feeds /transaction (the consolidated ledger) and the per-child payment histories.
-- Two kinds of row share this ledger: 'payment' is money somebody actually
-- moved, 'due' is the bill a parent opens the moment they mark their child's key
-- Paid. A Due row carries the key it was raised for, so the child's history can
-- show what it owes and what it has paid for.
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        REAL    NOT NULL,
  send_date     TEXT    NOT NULL,
  received_date TEXT,
  status        TEXT    NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Success','Rejected')),
  key_id        INTEGER REFERENCES keys(id) ON DELETE SET NULL,
  kind          TEXT    NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','due')),
  is_renew      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payments_sender   ON payments(sender_id);
CREATE INDEX IF NOT EXISTS idx_payments_receiver ON payments(receiver_id);
CREATE INDEX IF NOT EXISTS idx_payments_key      ON payments(key_id);

-- ---------------------------------------------------------- validity history
-- Every change to a key's validity is kept here: the controller's Edit Validity,
-- the Extend All utility and renewal extensions. No foreign key on key_id and a
-- snapshot of the key name, so the trail survives the key's own deletion.
CREATE TABLE IF NOT EXISTS validity_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      INTEGER NOT NULL,
  key_name    TEXT    NOT NULL,
  username    TEXT    NOT NULL,
  old_days    INTEGER NOT NULL,
  new_days    INTEGER NOT NULL,
  old_expire  TEXT    NOT NULL,
  new_expire  TEXT    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  change_date TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_validity_key ON validity_history(key_id);

-- ---------------------------------------------------------- transfer history
-- Every controller key transfer, with what moved with the key. Names are
-- snapshots so the trail stays readable even after a panel is deleted.
CREATE TABLE IF NOT EXISTS transfer_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id           INTEGER NOT NULL,
  key_name         TEXT    NOT NULL,
  from_id          INTEGER,
  from_name        TEXT    NOT NULL,
  to_id            INTEGER,
  to_name          TEXT    NOT NULL,
  username         TEXT    NOT NULL,
  bills_moved      INTEGER NOT NULL DEFAULT 0,
  pending_moved    REAL    NOT NULL DEFAULT 0,
  resets_carried   INTEGER NOT NULL DEFAULT 0,
  validity_carried INTEGER NOT NULL DEFAULT 0,
  transfer_date    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_transfer_key ON transfer_history(key_id);

-- ---------------------------------------------------------------- key resets
-- Each Reset Id click leaves a row: who reset it and which MAC was cleared.
-- Keyed by key_id with a name snapshot, so a transfer carries the whole trail.
CREATE TABLE IF NOT EXISTS key_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     INTEGER NOT NULL,
  key_name   TEXT    NOT NULL,
  username   TEXT    NOT NULL,
  old_mac    TEXT    NOT NULL DEFAULT '',
  reset_date TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_resets_key ON key_resets(key_id);

-- ---------------------------------------------------------------- news
CREATE TABLE IF NOT EXISTS news (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  body        TEXT    NOT NULL,
  target_role TEXT    NOT NULL,   -- panel role | appnews | allpanels | personal
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------- tokens
-- Populated by the client software in the real system; here by /api/token.
CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_label  TEXT    NOT NULL DEFAULT '',
  sensors     INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'valid',
  ts          TEXT    NOT NULL,
  received_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tokens_ts ON tokens(ts);

-- ---------------------------------------------------------- key token pool
-- Tokens pushed against a key (POST /api/tokens) and handed to the client
-- software once (GET /api/tokens). `consumed` marks a token as delivered so the
-- same token is not handed out twice; the software keeps its own local copy
-- until the user clears it. type separates the Server-1 (app) and Beta pools.
CREATE TABLE IF NOT EXISTS key_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL CHECK (type IN ('app','beta')),
  token       TEXT    NOT NULL,
  consumed    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_key_tokens_pool ON key_tokens(key_id, type, consumed);

-- ---------------------------------------------------------------- tickets
-- /today_result + /top_result read the day's rows out of this table.
CREATE TABLE IF NOT EXISTS tickets3 (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  src    TEXT NOT NULL DEFAULT '',
  dest   TEXT NOT NULL DEFAULT '',
  train  TEXT NOT NULL DEFAULT '',
  pay_mode TEXT NOT NULL DEFAULT '',
  mac    TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  ip     TEXT NOT NULL DEFAULT '',
  pnr    TEXT NOT NULL DEFAULT '',
  img    TEXT NOT NULL DEFAULT '',
  tdate  TEXT NOT NULL DEFAULT (date('now','localtime')),
  upload_identity TEXT,
  result_id TEXT,
  booking_time TEXT,
  uploaded_at TEXT,
  evidence TEXT,
  connection_kind TEXT,
  proxy_encrypted BLOB,
  observed_ip TEXT,
  ip_observed_at TEXT,
  ip_source TEXT,
  image_file TEXT,
  image_mime TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_tdate ON tickets3(tdate);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_upload_identity ON tickets3(upload_identity);
