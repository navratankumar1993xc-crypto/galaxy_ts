'use strict';
const store = require('../../db');
const { CHAIN_COLUMN, CHAIN_TIERS, DEMO_KEY_PREFIX } = require('../config');
const { subtreeIds, inClause, lineageOf } = require('./tree');

// ---------------------------------------------------------------------------
// Tile filters from the reference /home page. `status` and expiry are separate
// axes there (733 active + 8 deactive = 741 total, while 739 are date-expired),
// so Expired is computed from expire_date and does not imply Deactive.
// `demo` is not a tile — the dashboard only reads the eight keys listed in
// src/menu.js — it exists so the "Demo Keys" delete target has the same
// subtree-scoped, password-gated path as the other four.
// ---------------------------------------------------------------------------
const FILTERS = {
  all:        '1=1',
  active:     "k.status = 'active'",
  deactive:   "k.status = 'deactive'",
  paid:       'k.has_paid = 1',
  unpaid:     'k.has_paid = 0',
  mac_reg:    "k.mac <> ''",
  mac_unreg:  "k.mac = ''",
  demo:       "k.type = 'demo'",
  expired:    "datetime(k.expire_date) < datetime('now','localtime')"
};

// `alias` is the table qualifier inside the generated condition: SELECTs join
// keys as k, while an UPDATE has to name the table itself.
function scopeSql(rootId, alias = 'k') {
  const ids = subtreeIds(rootId);
  const { sql, params } = inClause(ids);
  return { sql: `${alias}.created_by_id IN (${sql})`, params };
}

// One entry per tier below the controller, in chain order, straight from
// CHAIN_TIERS: the denormalised column on `keys`, a join alias, and the field
// name the list views read. Adding a level in src/config.js lands here, in the
// joins, in the insert and in the table columns without a second edit.
const CHAIN = CHAIN_TIERS.map(function (tier) {
  return Object.assign({}, tier, { alias: 'u_' + tier.column.slice(0, -3) });
});

function joinChain() {
  return CHAIN.map(function (c) {
    return `LEFT JOIN users ${c.alias} ON ${c.alias}.id = k.${c.column}`;
  }).join('\n          ');
}

const SELECT_COLS = [
  'k.*',
  ...CHAIN.map(function (c) { return `COALESCE(${c.alias}.username,'') AS ${c.field}`; }),
  // The reference prints remaining days through PHP number_format(): signed and
  // rounded to no decimals, so a key that lapsed a few hours ago still reads
  // "-0". Only a value that rounds truly negative gets the bg-warning cell.
  `printf('%.0f', (strftime('%s', k.expire_date) - strftime('%s', 'now', 'localtime')) / 86400.0) AS left_days`,
  `((strftime('%s', k.expire_date) - strftime('%s', 'now', 'localtime')) / 86400.0 < -0.5) AS left_days_negative`
].join(',\n  ');

function list(rootId, filter = 'all') {
  const cond = FILTERS[filter] || FILTERS.all;
  const sc = scopeSql(rootId);
  return store.all(
    `SELECT ${SELECT_COLS} FROM keys k ${joinChain()}
      WHERE ${sc.sql} AND ${cond}
      ORDER BY k.id DESC`,
    sc.params
  );
}

function counts(rootId) {
  const sc = scopeSql(rootId);
  const out = {};
  for (const [name, cond] of Object.entries(FILTERS)) {
    out[name] = store.scalar(
      `SELECT COUNT(*) FROM keys k ${joinChain()} WHERE ${sc.sql} AND ${cond}`,
      sc.params
    ) || 0;
  }
  return out;
}

function get(id) {
  return store.get(`SELECT ${SELECT_COLS} FROM keys k ${joinChain()} WHERE k.id = ?`, [id]);
}

function getByName(name) {
  return store.get(`SELECT ${SELECT_COLS} FROM keys k ${joinChain()} WHERE k.key_name = ?`, [name]);
}

// A key may only be touched by someone in its own lineage.
function owns(rootUser, keyId) {
  const k = get(keyId);
  if (!k) return false;
  return subtreeIds(rootUser.id).includes(k.created_by_id);
}

function generate({ owner, days, type = 'normal', hasPaid = 0, mac = '', name = null, clientName = '', gift = false }) {
  const lineage = lineageOf(owner.id);
  const keyName = name || randomKey();
  const d = Number(days) || 1;
  // Every column that takes a parameter comes off this one list, so the
  // placeholder count and the value count cannot drift apart when a tier is
  // added. start_date, expire_date and status are SQLite expressions instead.
  const chainColumns = CHAIN.map(function (c) { return c.column; });
  const valueColumns = ['client_name', 'is_gift'].concat(chainColumns, ['created_by_id', 'days', 'has_paid', 'type']);
  store.run(
    `INSERT INTO keys (key_name, mac, ${valueColumns.join(', ')},
                       start_date, expire_date, status)
     VALUES (?, ?, ${valueColumns.map(() => '?').join(', ')},
             datetime('now','localtime'),
             datetime('now','localtime','+' || ? || ' days'),
             'active')`,
    [keyName, mac, String(clientName || '').trim(), gift ? 1 : 0,
      ...chainColumns.map(col => lineage[col]), owner.id, d, hasPaid ? 1 : 0, type, d]
  );
  return keyName;
}

function randomKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Public demo keys are numbered: DEMO01, DEMO02, DEMO03... Every click on the
// login page issues the next one, so each visitor gets a key they can type from
// memory and the counter only ever goes up. The number is read back off the
// rows, so deleting old demos does not make a new click collide with a name.
function nextDemoName(prefix = DEMO_KEY_PREFIX) {
  const top = store.scalar(
    `SELECT COALESCE(MAX(CAST(substr(key_name, ?) AS INTEGER)), 0) FROM keys
      WHERE key_name LIKE ? AND substr(key_name, ?) GLOB '[0-9]*'`,
    [prefix.length + 1, prefix + '%', prefix.length + 1]
  );
  return prefix + String(Number(top) + 1).padStart(2, '0');
}

// Two clicks in the same millisecond can pick the same number, and key_name is
// UNIQUE, so the insert is retried with the next number instead of failing.
function issueDemo({ owner, days, prefix = DEMO_KEY_PREFIX }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const keyName = nextDemoName(prefix);
    try {
      generate({ owner, days, type: 'demo', hasPaid: 1, name: keyName });
      return { keyName, id: store.scalar('SELECT id FROM keys WHERE key_name = ?', [keyName]) };
    } catch (err) {
      if (!/UNIQUE|PRIMARY/i.test(String(err && err.message))) throw err;
    }
  }
  throw new Error('could not pick a free demo key name');
}

// The client name is the only field the row editor writes. The key name is the
// key's identity — the seller chose it at creation and nobody edits it after.
function setClientName(id, name) {
  store.run('UPDATE keys SET client_name = ? WHERE id = ?', [String(name).trim(), id]);
}

// Handing a key to another panel re-points its lineage so it shows in that
// panel's list (and every panel above it). Works for any target below the
// controller; the money side of a full account transfer lives in payments.
function transferLineage(id, user) {
  const lineage = lineageOf(user.id);
  const chainColumns = CHAIN.map(function (c) { return c.column; });
  store.run(
    `UPDATE keys SET created_by_id = ?, ${chainColumns.map(function (c) { return c + ' = ?'; }).join(', ')}
      WHERE id = ?`,
    [user.id, ...chainColumns.map(function (c) { return lineage[c]; }), id]
  );
}

function remove(id) {
  store.run('DELETE FROM keys WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Who is allowed to delete a key: the controller, and nobody else.
//
// Deleting a key is the controller's job — not the panel that made it, not the
// tiers in between. Whether the key is Paid no longer enters into it, because
// the bill is its own record: when the key row goes, `payments.key_id` follows
// it to NULL and the row itself stays in the ledger.
// ---------------------------------------------------------------------------
function deletableBy(rootUser) {
  return rootUser.role === 'controller';
}

function addIp(id, ip) {
  const k = store.get('SELECT ips FROM keys WHERE id = ?', [id]);
  const list = (k && k.ips ? k.ips.split(',').filter(Boolean) : []);
  const value = String(ip).trim();
  if (value && !list.includes(value)) list.push(value);
  store.run('UPDATE keys SET ips = ? WHERE id = ?', [list.join(','), id]);
}

function extend(id, days) {
  store.run(
    `UPDATE keys SET expire_date = datetime(
        MAX(datetime(expire_date), datetime('now','localtime')), '+' || ? || ' days'),
        days = days + ?, status = 'active'
      WHERE id = ?`,
    [Number(days) || 0, Number(days) || 0, id]
  );
}

// ---------------------------------------------------------------------------
// Validity history: every change to a key's days/expiry leaves a row behind —
// the controller's Edit Validity, Extend All, and a paid renewal. The row keeps
// a snapshot of the key name and has no foreign key, so the trail outlives the
// key itself. `key` is the row as it was BEFORE the change.
// ---------------------------------------------------------------------------
function logValidity(key, username, newDays, newExpire, note) {
  store.run(
    `INSERT INTO validity_history (key_id, key_name, username, old_days, new_days, old_expire, new_expire, note)
     VALUES (?,?,?,?,?,?,?,?)`,
    [key.id, key.key_name, String(username || ''), Number(key.days), Number(newDays),
     key.expire_date, newExpire, String(note || '')]
  );
}

function validityLog(keyId) {
  return store.all('SELECT * FROM validity_history WHERE key_id = ? ORDER BY id DESC', [keyId]);
}

// Reset Id trail: one row per click, carrying the MAC that was cleared. Like the
// validity trail it hangs off key_id with a name snapshot, so a key transfer
// carries every reset with it and the record outlives the key.
function logReset(key, username) {
  store.run(
    'INSERT INTO key_resets (key_id, key_name, username, old_mac) VALUES (?,?,?,?)',
    [key.id, key.key_name, String(username || ''), key.mac || '']
  );
}

function resetLog(keyId) {
  return store.all('SELECT * FROM key_resets WHERE key_id = ? ORDER BY id DESC', [keyId]);
}

// The controller's complete transfer trail, newest first.
function transferLog() {
  return store.all('SELECT * FROM transfer_history ORDER BY id DESC');
}

// The expiry a relative extension lands on: never earlier than today, so an
// already-expired key restarts from now instead of digging further into the past.
function extendedExpire(oldExpire, days) {
  return store.scalar(
    `SELECT datetime(MAX(datetime(?), datetime('now','localtime')), '+' || ? || ' days')`,
    [oldExpire, Number(days) || 0]
  );
}

// Edit Validity: the controller types the validity the key should carry, and the
// key takes it exactly — more days pushes the expiry out, fewer days pulls it in.
// The new expiry is today + the entered days, recomputed on the spot, and the
// change is written to the history in the same transaction.
function setValidity(key, days, username) {
  const n = Number(days);
  const newExpire = store.scalar(`SELECT datetime('now','localtime','+' || ? || ' days')`, [n]);
  store.transaction(function () {
    store.run('UPDATE keys SET days = ?, expire_date = ? WHERE id = ?', [n, newExpire, key.id]);
    logValidity(key, username, n, newExpire, 'edit');
  });
  return { newExpire };
}

// Global Utilities on /all_key — applied to every key in the requester's subtree.
// Each key's change is logged on its own, so the history stays per-key.
function extendAll(rootUser, days) {
  const sc = scopeSql(rootUser.id);
  const n = Number(days) || 0;
  const rows = store.all(`SELECT k.* FROM keys k WHERE ${sc.sql}`, sc.params);
  store.transaction(function () {
    rows.forEach(function (k) {
      const newExpire = extendedExpire(k.expire_date, n);
      store.run('UPDATE keys SET expire_date = ?, days = days + ? WHERE id = ?', [newExpire, n, k.id]);
      logValidity(k, rootUser.username, Number(k.days) + n, newExpire, 'extend all');
    });
  });
}

function resetAllMac(rootUser) {
  const sc = scopeSql(rootUser.id, 'keys');
  store.run(`UPDATE keys SET mac = '' WHERE ${sc.sql}`, sc.params);
}

// The filter conditions are written against the aliased SELECT, so the delete
// goes through a rowid subquery instead of trying to alias the DELETE target.
function massDelete(rootUser, target) {
  const cond = FILTERS[target];
  if (!cond || target === 'all') return 0;
  const sc = scopeSql(rootUser.id);
  const info = store.run(
    `DELETE FROM keys WHERE rowid IN (SELECT k.id FROM keys k WHERE ${sc.sql} AND ${cond})`,
    sc.params
  );
  return Number(info.changes);
}

function setPaid(id, paid) {
  store.run('UPDATE keys SET has_paid = ? WHERE id = ?', [paid ? 1 : 0, id]);
}

// Renew Key: the seller's click flips a near-expiry Paid key back to UnPaid and
// raises this flag; the days are NOT added yet. The parent's mark-paid click is
// what consumes the flag (see payments.chargeKey) and extends the validity, so a
// renewal that is never paid for never grants free days.
function setRenewPending(id, pending) {
  store.run('UPDATE keys SET renew_pending = ? WHERE id = ?', [pending ? 1 : 0, id]);
}

function setStatus(id, status) {
  store.run('UPDATE keys SET status = ? WHERE id = ?', [status, id]);
}

function setMac(id, mac) {
  store.run('UPDATE keys SET mac = ? WHERE id = ?', [String(mac).trim(), id]);
}

// ---------------------------------------------------------------------------
// Cascade rules, re-evaluated on every render:
//   * an unpaid key is suspended once key_grace_hours pass its expiry
//   * when a panel closes for dues, keys created inside it survive child_grace_hours
// Running out of days on its own does NOT suspend a key: on the reference 739
// of 741 keys are past expiry and 733 of them are still active, so status only
// changes for unpaid keys or through the manual Activated/Not Activated button.
// ---------------------------------------------------------------------------
function enforceCascades(settings) {
  const keyGrace = Number(settings.key_grace_hours || 48);
  const childGrace = Number(settings.child_grace_hours || 24);

  store.run(
    `UPDATE keys SET status = 'deactive'
      WHERE status = 'active'
        AND has_paid = 0
        AND datetime(expire_date, '+' || ? || ' hours') < datetime('now','localtime')`,
    [keyGrace]
  );

  store.run(
    `UPDATE keys SET status = 'deactive'
      WHERE status = 'active'
        AND created_by_id IN (
              SELECT id FROM users
               WHERE status = 'closed'
                 AND datetime(closed_at, '+' || ? || ' hours') < datetime('now','localtime')
            )`,
    [childGrace]
  );
}

// Chain column for a role, used when a tier wants only its own keys.
function chainColumnFor(role) {
  return CHAIN_COLUMN[role] || null;
}

// /reports keys are grouped by the day they were created (start_date), which is
// what the reference's breakdown table prints in its "Created Date" column.
function inRange(rootId, from, to) {
  const sc = scopeSql(rootId);
  return store.all(
    `SELECT ${SELECT_COLS} FROM keys k ${joinChain()}
      WHERE ${sc.sql} AND date(k.start_date) BETWEEN date(?) AND date(?)
      ORDER BY k.id DESC`,
    [...sc.params, from, to]
  );
}

function pairLimitRows() {
  return store.all(
    `SELECT id, key_name, client_name, status, limit_total, limit_app, limit_beta
       FROM keys ORDER BY id DESC`
  );
}

function setPairLimits(id, total, app, beta) {
  store.run('UPDATE keys SET limit_total = ?, limit_app = ?, limit_beta = ? WHERE id = ?',
    [total, app, beta, id]);
}

module.exports = {
  FILTERS, list, counts, get, getByName, owns, generate, issueDemo, nextDemoName, setClientName, transferLineage, remove, addIp, extend,
  extendAll, resetAllMac, massDelete, deletableBy, setPaid, setRenewPending, setMac, setStatus, enforceCascades,
  setValidity, logValidity, validityLog, extendedExpire, logReset, resetLog, transferLog,
  chainColumnFor, inRange, randomKey, pairLimitRows, setPairLimits
};
