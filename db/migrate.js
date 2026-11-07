'use strict';
// ---------------------------------------------------------------------------
// Schema upgrades for a database that already exists.
//
// schema.sql uses CREATE TABLE IF NOT EXISTS, so a stored table is never
// touched by it. Adding the Super Seller tier changes two things an older
// database cannot get on its own: a `keys.super_seller_id` column, and the
// role CHECK lists on `users` and `role_prices`, which still name only six
// tiers. Both are repaired here so the panel upgrades in place instead of
// demanding a reset.
//
// A rebuild is deliberately dumb: the new definition is built in a shadow
// table, the columns are compared name-for-name, and only an exact match is
// allowed to copy the rows across. Anything else throws and the transaction
// rolls back, leaving the original table untouched.
//
// The key-payment flow needs two more columns on `payments`, which is the
// ledger holding real money. Those go on with plain ALTER statements, because a
// rebuild of a table the owner's balances live in is exactly the kind of thing
// this file should never do on a working database.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function tableDdl(table) {
  const m = new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);').exec(SCHEMA);
  if (!m) throw new Error('db/schema.sql has no CREATE TABLE for ' + table);
  return m[0].replace('CREATE TABLE IF NOT EXISTS ' + table, 'CREATE TABLE ' + table + '_upgrade');
}

function columns(db, table) {
  return db.prepare('PRAGMA table_info(' + table + ')').all().map(function (c) { return c.name; });
}

function storedSql(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row ? String(row.sql) : '';
}

function hasTable(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

// The panel runs with SQLite's default (foreign keys OFF), so the rebuild has to
// put that back rather than leave the connection enforcing keys app-wide.
function foreignKeysAreOn(db) {
  return Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1;
}

function rebuild(db, table, indexes) {
  const shadow = table + '_upgrade';
  const wasOn = foreignKeysAreOn(db);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('DROP TABLE IF EXISTS ' + shadow);
    db.exec(tableDdl(table));
    const want = columns(db, shadow);
    const have = columns(db, table);
    if (want.join('|') !== have.join('|')) {
      throw new Error(table + ' has columns [' + have.join(', ') + '] but the new schema wants [' +
        want.join(', ') + '] — run `npm run db:reset` for a database this old.');
    }
    db.exec('INSERT INTO ' + shadow + ' SELECT * FROM ' + table);
    db.exec('DROP TABLE ' + table);
    db.exec('ALTER TABLE ' + shadow + ' RENAME TO ' + table);
    (indexes || []).forEach(function (sql) { db.exec(sql); });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    try { db.exec('DROP TABLE IF EXISTS ' + shadow); } catch (ignored) { /* nothing to undo */ }
    db.exec('PRAGMA foreign_keys = ' + (wasOn ? 'ON' : 'OFF'));
    throw new Error('schema upgrade failed: ' + err.message);
  }
  db.exec('PRAGMA foreign_keys = ' + (wasOn ? 'ON' : 'OFF'));
}

// Runs BEFORE schema.sql: an old database needs the new column to exist, or the
// index statement at the bottom of schema.sql fails on a column it has never
// heard of. On a fresh database there are no tables yet, so nothing happens and
// schema.sql builds everything.
function upgrade(db) {
  const done = [];

  if (hasTable(db, 'keys') && !columns(db, 'keys').includes('super_seller_id')) {
    db.exec('ALTER TABLE keys ADD COLUMN super_seller_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    done.push('keys.super_seller_id added');
  }

  // The seller's "Generate New Key" modal asks for the customer's name. It is
  // kept beside the key so the seller can tell two keys apart at a glance.
  if (hasTable(db, 'keys') && !columns(db, 'keys').includes('client_name')) {
    db.exec("ALTER TABLE keys ADD COLUMN client_name TEXT NOT NULL DEFAULT ''");
    done.push('keys.client_name added');
  }

  // Gift keys: handed to a seller by the controller, free and already Paid. A
  // plain flag on the existing row keeps every old key a non-gift and avoids
  // rebuilding a table the owner's keys live in.
  if (hasTable(db, 'keys') && !columns(db, 'keys').includes('is_gift')) {
    db.exec('ALTER TABLE keys ADD COLUMN is_gift INTEGER NOT NULL DEFAULT 0');
    done.push('keys.is_gift added');
  }

  // Renew Key: a seller flips a near-expiry Paid key back to UnPaid and waits
  // for its parent to mark it Paid, which is what adds the days. The flag marks
  // "renew requested, extension still owed" so the extension lands exactly once,
  // at the mark-paid click, and never on an ordinary first bill.
  if (hasTable(db, 'keys') && !columns(db, 'keys').includes('renew_pending')) {
    db.exec('ALTER TABLE keys ADD COLUMN renew_pending INTEGER NOT NULL DEFAULT 0');
    done.push('keys.renew_pending added');
  }

  if (hasTable(db, 'users') && !/super_seller/.test(storedSql(db, 'users'))) {
    rebuild(db, 'users', [
      'CREATE INDEX IF NOT EXISTS idx_users_parent ON users(parent_id)',
      'CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)'
    ]);
    done.push('users role list rebuilt');
  }

  if (hasTable(db, 'role_prices') && !/super_seller/.test(storedSql(db, 'role_prices'))) {
    rebuild(db, 'role_prices', []);
    done.push('role_prices role list rebuilt');
  }

  // Key bills share the payments ledger, so an older panel needs the two
  // columns. Both have a default, so every row already in there simply becomes a
  // normal transfer ('payment') and no due is invented for money that moved
  // before this rule existed.
  if (hasTable(db, 'payments')) {
    const paid = columns(db, 'payments');
    if (!paid.includes('key_id')) {
      db.exec('ALTER TABLE payments ADD COLUMN key_id INTEGER REFERENCES keys(id) ON DELETE SET NULL');
      done.push('payments.key_id added');
    }
    if (!paid.includes('kind')) {
      db.exec("ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'payment' " +
              "CHECK (kind IN ('payment','due'))");
      done.push('payments.kind added');
    }
    // A renewal bill is tagged so the histories can label the row Renew instead
    // of leaving it indistinguishable from a first bill.
    if (!paid.includes('is_renew')) {
      db.exec('ALTER TABLE payments ADD COLUMN is_renew INTEGER NOT NULL DEFAULT 0');
      done.push('payments.is_renew added');
    }
  }

  return done;
}

module.exports = { upgrade };
