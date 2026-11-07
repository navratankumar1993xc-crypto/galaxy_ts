'use strict';
// ---------------------------------------------------------------------------
// Money flow between two panels, end to end: due -> partial transfer -> Accept
// -> balance -> 1-Click Accept -> settled ledger on both sides.
//
// This is the path a seller's due takes once it exists (scripts/check_keypay.js
// proves how a key bill gets there). Two things are worth stating because the
// suite checks them: the due only falls when the parent accepts, not when the
// child sends, and a panel that is not the payer's own parent cannot accept —
// Accept is refused and the pending row stays pending.
//
// Like the other live suites this runs against the database the panel is running
// on, so it never calls db:reset and never signs in as one of the owner's
// accounts. It starts from YOGIMASTER, builds a throwaway MNY* branch under it,
// and deletes that branch again at the end; the last assertion is that every row
// it did not create is still there, value for value.
// ---------------------------------------------------------------------------
const BASE = process.env.GALAXY_BASE || 'http://localhost:3000';
const store = require('../db');
const { boldText } = require('../src/config');

const SEED = { user: 'YOGIMASTER', pass: 'demo123' };   // master_admin, seeded
const ADMIN = 'MNYADM';        // admin         -> makes the super seller
const SUPER = 'MNYSUP';        // super_seller  -> the payer's parent, does the accepting
const SELLER = 'MNYSELL';      // seller        -> owes the money and sends it
const STRANGER = 'MNYOUT';     // admin         -> the payer's grandparent: must not accept
const PASS = 'mny12345';

let failures = 0;
function check(name, want, got) {
  const ok = String(want) === String(got);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got)));
}

// ------------------------------------------------------------------ tiny client
function jar() {
  let cookie = '';
  async function send(path, { method = 'GET', body = null } = {}) {
    const res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      headers: Object.assign(
        { Cookie: cookie },
        body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}
      ),
      body: body ? new URLSearchParams(body).toString() : null
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const pair = String(c).split(';')[0];
      if (pair.includes('=')) cookie = pair;
    }
    return { status: res.status, location: res.headers.get('location'), html: await res.text() };
  }
  return {
    get: (p) => send(p),
    post: (p, body) => send(p, { method: 'POST', body }),
    // A POST that refuses answers with a redirect too, so a 302 on its own proves
    // nothing — including for a login. This signs in and reads /home, which only a
    // session that really exists can serve.
    async enter(username, password) {
      await send('/login', { method: 'POST', body: { username, password } });
      const home = await send('/home');
      if (home.status !== 200) throw new Error('could not sign in as ' + username + ' (status ' + home.status + ')');
      return home;
    }
  };
}

// ------------------------------------------------------------------ live rows
// A record badge, matched exactly: the page prints the same words as column
// headings too, and they are set in the same mathematical-bold alphabet the views
// use, so the helper has to bold the text before comparing it. Whitespace goes
// out of both sides because the markup puts the text on its own line.
function hasBadge(html, kind, text) {
  const flat = html.replace(/\s+/g, '');
  return flat.indexOf('<spanclass="badgebadge-' + kind + '">' + text.replace(/\s+/g, '') + '</span>') >= 0;
}
function userOf(name) {
  const u = store.get('SELECT * FROM users WHERE username = ?', [name]);
  return u || null;
}
function dueOf(name) {
  const u = userOf(name);
  return u ? Number(u.due) : null;
}
function priceOf(role) {
  return Number(store.scalar('SELECT price FROM role_prices WHERE role = ?', [role]));
}
// The transfers between the two test panels, oldest first, whatever their state.
function rows(senderName, receiverName) {
  return store.all(
    `SELECT p.* FROM payments p
      JOIN users s ON s.id = p.sender_id JOIN users r ON r.id = p.receiver_id
     WHERE s.username = ? AND r.username = ? ORDER BY p.id`,
    [senderName, receiverName]
  );
}
// Everything that is not this test's own branch, as one comparable string.
function snapshot() {
  return JSON.stringify(store.all(
    "SELECT id, username, role, due, status FROM users WHERE username NOT LIKE 'MNY%' ORDER BY id"
  )) + JSON.stringify(store.all(
    "SELECT id, key_name, has_paid, status FROM keys WHERE key_name NOT LIKE 'MNY%' ORDER BY id"
  )) + JSON.stringify(store.all(
    "SELECT id, sender_id, receiver_id, amount, status FROM payments ORDER BY id"
  ));
}

(async function main() {
  const sellerPrice = priceOf('seller');
  const superPrice = priceOf('super_seller');
  if (!sellerPrice || !superPrice) throw new Error('seller/super_seller need prices on this database; set them on /set_price first');
  const half = Math.round(sellerPrice / 2);

  const before = snapshot();
  const seedJ = jar(); await seedJ.enter(SEED.user, SEED.pass);
  // Deleting accounts is the controller's alone (Final Delete Permission Rule);
  // the branch is built under YOGIMASTER but removed by the controller login.
  const ctrlJ = jar(); await ctrlJ.enter('admin', 'admin123');

  // ---- the throwaway branch, built through the panels themselves. Two rules
  // shape it: /add_user takes its parent from the session, and a panel may only
  // create the one role directly below it — so the chain runs master admin,
  // admin, super seller, seller, and the stranger is the payer's grandparent.
  const jars = { [ADMIN]: jar(), [STRANGER]: jar(), [SUPER]: jar(), [SELLER]: jar() };
  async function build(parentJar, parentName, child, role) {
    await parentJar.post('/add_user', { user_name: child, password: PASS, role: role });
    if (!userOf(child)) throw new Error(parentName + ' could not create ' + child + ' (a ' + role + ')');
    await jars[child].enter(child, PASS);
  }
  await build(seedJ, SEED.user, ADMIN, 'admin');
  await build(seedJ, SEED.user, STRANGER, 'admin');
  await build(jars[ADMIN], ADMIN, SUPER, 'super_seller');
  await build(jars[SUPER], SUPER, SELLER, 'seller');
  const superJ = jars[SUPER]; const sellJ = jars[SELLER]; const outJ = jars[STRANGER];

  console.log('\n1. creating a panel never bills it');
  check(SELLER + ' due at creation', 0, dueOf(SELLER));
  check(SUPER + ' due at creation', 0, dueOf(SUPER));
  check(SELLER + ' parent', userOf(SUPER).id, userOf(SELLER).parent_id);

  // The transfer flow below needs an existing due. Creation no longer raises
  // one, so the fixture charges the seller the way a key bill would.
  require('../src/queries/users').addDue(userOf(SELLER).id, sellerPrice);

  const ph = (await sellJ.get('/payment_history')).html;
  console.log('\n2. the payer sees what it owes and a way to send it');
  check('its page carries the Send Payment field', true, /name="amount"/.test(ph));
  check('the field starts at the whole due', true, ph.includes('value="' + sellerPrice + '"'));

  console.log('\n3. a partial transfer goes Pending and does not touch the due');
  await sellJ.post('/send_payment', { amount: String(half) });
  const pending = rows(SELLER, SUPER);
  check('one row submitted', 1, pending.length);
  check('its status', 'Pending', pending[0] && pending[0].status);
  check('its amount', half, pending[0] && Number(pending[0].amount));
  check('the due is untouched until the parent accepts', sellerPrice, dueOf(SELLER));
  check('the payer page reads Pending', true, hasBadge((await sellJ.get('/payment_history')).html, 'warning', boldText('Pending')));

  console.log('\n4. the parent sees the payer and can accept it');
  const board = (await superJ.get('/payment_history')).html;
  check('Accept names this payer', true, board.includes('name="sender_id" value="' + userOf(SELLER).id + '"'));
  check('1-Click Accept is offered too', true, board.includes('name="all" value="1"'));

  console.log('\n5. a panel that is not the payer’s own parent is refused');
  await outJ.post('/accept_payment', { sender_id: String(userOf(SELLER).id), amount: String(half) });
  check('the row is still Pending', 'Pending', (rows(SELLER, SUPER)[0] || {}).status);
  check('the stranger invented no payment', 0, rows(SELLER, STRANGER).length);
  check('the due is still the whole price', sellerPrice, dueOf(SELLER));

  console.log('\n6. the parent accepts: the transfer settles and the due falls');
  await superJ.post('/accept_payment', { sender_id: String(userOf(SELLER).id), amount: String(half) });
  const done1 = rows(SELLER, SUPER);
  check('still one row for that transfer', 1, done1.length);
  check('it is Success', 'Success', done1[0] && done1[0].status);
  check('and dated', true, !!(done1[0] && done1[0].received_date));
  check('the due dropped by what arrived', sellerPrice - half, dueOf(SELLER));
  check('the payer page reads Done', true,
    hasBadge((await sellJ.get('/payment_history')).html, 'success', boldText('Done') + ' &#9989;'));

  console.log('\n7. the balance goes through 1-Click Accept');
  const rest = sellerPrice - half;
  await sellJ.post('/send_payment', { amount: String(rest) });
  check('two transfers now', 2, rows(SELLER, SUPER).length);
  await superJ.post('/accept_payment', { sender_id: String(userOf(SELLER).id), all: '1' });
  const done2 = rows(SELLER, SUPER);
  check('both settled', 'Success,Success', done2.map(r => r.status).join(','));
  check('the due is cleared', 0, dueOf(SELLER));
  check('nothing left to accept', 0, store.scalar(
    `SELECT COUNT(*) FROM payments p WHERE p.sender_id = ? AND p.status = 'Pending'`, [userOf(SELLER).id]));

  console.log('\n8. both ledgers tell the same story');
  // /transaction prints the transfer status as it is stored, so both sides have
  // to carry two Success badges and neither may still show a Pending one.
  const sellTx = (await sellJ.get('/transaction')).html;
  const superTx = (await superJ.get('/transaction')).html;
  check('the payer’s transaction page lists both transfers', 2,
    (sellTx.match(/badge-success/g) || []).length);
  check('with nothing left pending there', 0, (sellTx.match(/badge-warning/g) || []).length);
  check('the parent’s page agrees', 2, (superTx.match(/badge-success/g) || []).length);
  check('and names the payer', true, superTx.includes(SELLER));

  console.log('\n8b. the receipt opens for both parties and the controller only');
  const pid = done2[0].id;
  check('the payer opens its receipt', 200, (await sellJ.get('/receipt?id=' + pid)).status);
  const rc = await superJ.get('/receipt?id=' + pid);
  check('the receiver opens the same receipt', 200, rc.status);
  check('the receipt names both parties', true, rc.html.includes(SELLER) && rc.html.includes(SUPER));
  check('the receipt carries the received date', true, rc.html.includes(String(done2[0].received_date).slice(0, 10)));
  check('the controller keeps final control', 200, (await ctrlJ.get('/receipt?id=' + pid)).status);
  check('a stranger is refused', true, (await outJ.get('/receipt?id=' + pid)).status !== 200);

  console.log('\n9. cleanup: the MNY branch leaves the database');
  for (const root of [ADMIN, STRANGER]) {
    await ctrlJ.post('/delete_user_cascade', { root_id: String(userOf(root).id) });
  }
  for (const name of [SELLER, SUPER, ADMIN, STRANGER]) check(name + ' gone', null, userOf(name));
  check('no payments left pointing at deleted panels', 0, store.scalar(
    `SELECT COUNT(*) FROM payments WHERE sender_id NOT IN (SELECT id FROM users) OR receiver_id NOT IN (SELECT id FROM users)`));

  check('the owner data is untouched', true, snapshot() === before);

  console.log('\nmoney failures: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
