'use strict';
// Assertions for scripts/smoke_chain.sh. Each mode reads the live database and
// prints ok/FAIL lines, so the shell script stays a plain driver.
const store = require('../db');

const mode = process.argv[2];
// Without a mode every block below is skipped and the suite would report a
// clean 0 failures having asserted nothing, so an empty run is itself a failure.
const MODES = ['dues', 'chainbilled', 'key', 'pending', 'settled', 'blocked', 'cleaned'];
if (!MODES.includes(mode)) {
  console.log('  FAIL  usage: node scripts/check_chain.js <' + MODES.join('|') + '>');
  process.exit(1);
}
let failures = 0;
function check(label, expected, actual) {
  const ok = String(expected) === String(actual);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + '  expected=' + expected + ' actual=' + actual);
}
const id = username => store.scalar(`SELECT id FROM users WHERE username = ?`, [username]);
const row = username => store.get(`SELECT * FROM users WHERE username = ?`, [username]);
const byId = userId => store.get(`SELECT * FROM users WHERE id = ?`, [userId]);

if (mode === 'dues') {
  const chain = [
    ['CHAINDEV', 'developer', 'admin'],
    ['CHAINSM', 'super_master_admin', 'CHAINDEV'],
    ['CHAINMA', 'master_admin', 'CHAINSM'],
    ['CHAINAD', 'admin', 'CHAINMA'],
    ['CHAINSUP', 'super_seller', 'CHAINAD'],
    ['CHAINSL', 'seller', 'CHAINSUP']
  ];
  for (const [u, role, parent] of chain) {
    const me = row(u);
    check(u + ' role', role, me && me.role);
    check(u + ' parent', parent, me && byId(me.parent_id).username);
    // Creating a panel never bills it: every fresh login carries due 0.
    check(u + ' due at creation', 0, me && me.due);
  }
}

if (mode === 'chainbilled') {
  // One Paid click bills every level of the chain at its own role price; the
  // controller receives but is never billed.
  const prices = {};
  for (const p of store.all(`SELECT role, price FROM role_prices`)) prices[p.role] = p.price;
  for (const u of ['CHAINDEV', 'CHAINSM', 'CHAINMA', 'CHAINAD', 'CHAINSUP', 'CHAINSL']) {
    const me = row(u);
    check(u + ' due after the chain bill', me && prices[me.role], me && me.due);
  }
  check('controller never billed', 0, row('admin') && row('admin').due);
}

// The denormalised chain columns on `keys`, tier by tier, in chain order.
const CHAIN_COLUMNS = {
  developer_id: 'CHAINDEV',
  super_master_admin_id: 'CHAINSM',
  master_admin_id: 'CHAINMA',
  admin_id: 'CHAINAD',
  super_seller_id: 'CHAINSUP',
  seller_id: 'CHAINSL'
};

if (mode === 'key') {
  const key = store.get(`SELECT * FROM keys WHERE created_by_id = ? ORDER BY id DESC LIMIT 1`, [id('CHAINSL')]);
  check('seller has a key', true, !!key);
  if (key) {
    // Each tier has its own column on the key, so a new level only needs its
    // entry in CHAIN_COLUMNS above.
    for (const [column, name] of Object.entries(CHAIN_COLUMNS)) {
      check('chain ' + column, name, key[column] ? byId(key[column]).username : null);
    }
    check('status', 'active', key.status);
    check('type', 'normal', key.type);
    // Every ancestor up to the controller must list this key in its own subtree.
    const names = ['CHAINDEV', 'CHAINSM', 'CHAINMA', 'CHAINAD', 'CHAINSUP', 'admin'];
    const { subtreeIds } = require('../src/queries/tree');
    for (const n of names) {
      check('visible from ' + n, 1, subtreeIds(id(n)).includes(key.created_by_id) ? 1 : 0);
    }
  }
}

if (mode === 'pending') {
  const p = store.get(`SELECT p.*, s.username snd, r.username rcv FROM payments p
      LEFT JOIN users s ON s.id = p.sender_id LEFT JOIN users r ON r.id = p.receiver_id
     WHERE s.username = 'CHAINSL' ORDER BY p.id DESC LIMIT 1`);
  check('pending sender', 'CHAINSL', p && p.snd);
  check('pending receiver', 'CHAINSUP', p && p.rcv);
  check('pending status', 'Pending', p && p.status);
  // The parent's page must actually carry the Accept control for this payer.
  const html = require('fs').readFileSync(require('path').join(process.env.TEMP, 'ph_chain.html'), 'utf8');
  check('parent page offers Accept', true,
    html.includes('name="sender_id" value="' + id('CHAINSL') + '"'));
}

if (mode === 'settled') {
  const p = store.get(`SELECT p.*, s.username snd, r.username rcv FROM payments p
      LEFT JOIN users s ON s.id = p.sender_id LEFT JOIN users r ON r.id = p.receiver_id
     WHERE s.username = 'CHAINSL' ORDER BY p.id DESC LIMIT 1`);
  check('status after accept', 'Success', p && p.status);
  check('received_date set', true, !!(p && p.received_date));
  check('CHAINSL due back to 0', 0, row('CHAINSL').due);
  check('CHAINSL panel reopened', 'active', row('CHAINSL').status);
}

if (mode === 'blocked') {
  // /status_update and /delete_user_cascade answer with a flash, not a code, so
  // the assertion is that nothing actually changed.
  check('parent CHAINMA still exists', 1, store.scalar(`SELECT COUNT(*) FROM users WHERE username='CHAINMA'`));
  check('parent CHAINMA still active', 'active', row('CHAINMA').status);
  check('CHAINDEV survived an upward delete', 1, store.scalar(`SELECT COUNT(*) FROM users WHERE username='CHAINDEV'`));
  check('CHAINAD unchanged', 'active', row('CHAINAD').status);
  check('no payment invented for CHAINAD', 0,
    store.scalar(`SELECT COUNT(*) FROM payments WHERE sender_id = ? AND receiver_id = ? AND status <> 'Success'`,
      [id('CHAINMA'), id('CHAINAD')]));
}

if (mode === 'cleaned') {
  for (const u of ['CHAINDEV', 'CHAINSM', 'CHAINMA', 'CHAINAD', 'CHAINSUP', 'CHAINSL']) {
    check(u + ' removed', 0, store.scalar(`SELECT COUNT(*) FROM users WHERE username = ?`, [u]));
  }
  check('no orphan CHAIN keys', 0, store.scalar(
    `SELECT COUNT(*) FROM keys WHERE created_by_id NOT IN (SELECT id FROM users)`));
  // The driver hands over the inventory it found before building the chain, so
  // the promise is that everything that was here already is still here — which
  // holds on the owner's live database as well as on a freshly seeded one.
  const baseUsers = Number(process.env.CHAIN_BASE_USERS);
  const baseKeys = Number(process.env.CHAIN_BASE_KEYS);
  if (!baseUsers || !baseKeys) {
    console.log('  --    inventory restored: skipped, CHAIN_BASE_USERS/CHAIN_BASE_KEYS were not exported');
  } else {
    check('the panels found before are all back', baseUsers, store.scalar(`SELECT COUNT(*) FROM users`));
    check('the keys found before are all back', baseKeys, store.scalar(`SELECT COUNT(*) FROM keys`));
  }
}

console.log('  chain failures (' + mode + '): ' + failures);
process.exit(failures ? 1 : 0);
