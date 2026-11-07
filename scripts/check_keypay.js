'use strict';
// ---------------------------------------------------------------------------
// Key lifecycle, end to end.
//
// The rules this checks:
//   * a key is created by a seller and starts UnPaid, billing nobody;
//   * only the panel directly above the creator can mark it Paid, and that
//     click raises the Due on the creator and fills its Payment History;
//   * the parent receives the money with the Accept button it already had;
//   * deleting a key is the controller's job alone — not the creator's and not
//     the tiers in between — and so is changing a key's validity;
//   * every login may correct a key's client name, while the key name itself is
//     fixed when the seller creates it, for every login.
//
// It runs against the database the panel is live on, so it never calls db:reset
// and never signs in as one of the owner's accounts. It starts from YOGIMASTER
// (the seeded demo chain, whose password nothing here changes), builds its own
// three-level KPT branch — admin, super seller, seller — and deletes that branch
// again at the end. The last thing it does is prove the rows that were already
// there, owner data like RANI and RAJA22, are still there, value for value.
// ---------------------------------------------------------------------------
const BASE = process.env.GALAXY_BASE || 'http://localhost:3000';
const store = require('../db');
const { boldText } = require('../src/config');

const SEED = { user: 'YOGIMASTER', pass: 'demo123' };   // master_admin, seeded
// The three jobs the brief splits by role: a seller creates keys, the controller
// alone deletes them and alone changes their validity. This is the build's own
// seeded controller login, the same one smoke_tiers.sh and check_pages.js use.
const CONTROLLER = { user: 'admin', pass: 'admin123' };
const KPT_ADMIN = 'KPTMA';      // admin         -> grandparent of the key: must not bill
const KPT_SUPER = 'KPTSP';      // super_seller  -> the direct parent: does the marking
const KPT_SELLER = 'KPTSL';     // seller        -> makes the keys and owes the dues
const KPT_SELLER2 = 'KPTSL2';   // seller        -> second panel, to prove gift transfer
const KPT_PASS = 'kpt12345';

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
    // Every POST that refuses a request answers with a redirect, so a 302 on its
    // own proves nothing — including for a login. This signs in and then reads
    // /home, which only a session that really exists can serve.
    async enter(username, password) {
      await send('/login', { method: 'POST', body: { username, password } });
      const home = await send('/home');
      if (home.status !== 200) throw new Error('could not sign in as ' + username + ' (status ' + home.status + ')');
      return home;
    }
  };
}

// ------------------------------------------------------------------ live rows
// A record badge, matched exactly: the same page also prints "Due Amount" and
// "Paid By (Sender)" as column headings, so the bare word would prove nothing.
// Whitespace goes out of both sides because the markup puts the text on its own
// line inside the span.
function hasBadge(html, kind, text) {
  const flat = html.replace(/\s+/g, '');
  return flat.indexOf('<spanclass="badgebadge-' + kind + '">' + text.replace(/\s+/g, '') + '</span>') >= 0;
}
function userOf(name) {
  const u = store.get('SELECT * FROM users WHERE username = ?', [name]);
  return u || null;
}
function keyOf(name) {
  const k = store.get('SELECT * FROM keys WHERE key_name = ?', [name]);
  return k || null;
}
function dueOf(name) {
  const u = userOf(name);
  return u ? Number(u.due) : null;
}
function billRows(name) {
  const u = userOf(name);
  if (!u) return [];
  return store.all(
    `SELECT p.*, k.key_name FROM payments p LEFT JOIN keys k ON k.id = p.key_id
      WHERE p.sender_id = ? AND p.kind = 'due' ORDER BY p.id`,
    [u.id]
  );
}
// Everything that is not this test's own branch, as one comparable string.
function snapshot() {
  return JSON.stringify(store.all(
    "SELECT id, username, role, due, status FROM users WHERE username NOT LIKE 'KPT%' ORDER BY id"
  )) + JSON.stringify(store.all(
    "SELECT id, key_name, has_paid, status, days FROM keys WHERE key_name NOT LIKE 'KPT%' ORDER BY id"
  )) + JSON.stringify(store.all(
    "SELECT id, sender_id, receiver_id, amount, status FROM payments WHERE kind IS NULL OR kind = 'payment' ORDER BY id"
  ));
}

(async function main() {
  const price = Number(store.scalar("SELECT price FROM role_prices WHERE role = 'seller'"));
  if (!price) throw new Error('the seller role has no price on this database; set one on /set_price first');
  // The controller's seller-key validity: the one length a seller's keys run for.
  const sellerDays = Number(store.scalar("SELECT value FROM settings WHERE key = 'panel_days'")) || 30;

  const before = snapshot();

  const master = jar(); const admin = jar(); const up = jar(); const sell = jar();
  const sell2 = jar();
  const ctrl = jar();
  await master.enter(SEED.user, SEED.pass);
  // The controller is the one seeded login that deletes and extends; it is the
  // same account smoke_tiers.sh and check_pages.js use.
  await ctrl.enter(CONTROLLER.user, CONTROLLER.pass);

  // ---- a private branch of the tree, built through the panel itself
  await master.post('/add_user', { user_name: KPT_ADMIN, password: KPT_PASS, role: 'admin' });
  await admin.enter(KPT_ADMIN, KPT_PASS);
  await admin.post('/add_user', { user_name: KPT_SUPER, password: KPT_PASS, role: 'super_seller' });
  await up.enter(KPT_SUPER, KPT_PASS);
  await up.post('/add_user', { user_name: KPT_SELLER, password: KPT_PASS, role: 'seller' });
  await sell.enter(KPT_SELLER, KPT_PASS);
  await up.post('/add_user', { user_name: KPT_SELLER2, password: KPT_PASS, role: 'seller' });
  await sell2.enter(KPT_SELLER2, KPT_PASS);
  check('the seller sits under the super seller', userOf(KPT_SUPER).id, userOf(KPT_SELLER).parent_id);
  check('and the super seller under the admin', userOf(KPT_ADMIN).id, userOf(KPT_SUPER).parent_id);
  const panelDue = dueOf(KPT_SELLER);

  // ============================================================ 1. created unpaid
  console.log('\n1. a seller makes the key, and it starts UnPaid and bills nobody');
  const gen = await sell.post('/generate_key', {
    days: '30', name: 'KPTKEY1', mac: 'AA:BB:CC:DD:EE:01', client_name: 'Test Client'
  });
  check('generate redirect', 302, gen.status);
  const k1 = keyOf('KPTKEY1');
  check('key exists', 'KPTKEY1', k1 && k1.key_name);
  check('has_paid at creation', 0, k1 && k1.has_paid);
  check('created_by is the seller', userOf(KPT_SELLER).id, k1 && k1.created_by_id);
  check('the client name is stored with the key', 'Test Client', k1 && k1.client_name);
  check('no bill yet', 0, billRows(KPT_SELLER).length);
  check('creating a key does not touch the due', panelDue, dueOf(KPT_SELLER));

  const ownList = (await sell.get('/all_key')).html;
  check('the seller sees it as UnPaid', true, /𝐔𝐧𝐏𝐚𝐢𝐝/.test(ownList));
  check('the seller gets no Mark Paid control', false, ownList.indexOf('/mark_key_paid') >= 0);

  // The table prints the device MAC ID beside the key, so a seller can see which
  // machine a key is bound to.
  check('the seller table carries the Mac ID column', true, ownList.indexOf('<th>Mac ID</th>') >= 0);
  check('the Mac ID shows the registered MAC', true, ownList.indexOf('AA:BB:CC:DD:EE:01') >= 0);
  check('the table carries the Client Name column', true, ownList.indexOf('<th>Client Name</th>') >= 0);
  check('the client name is printed in its column', true, ownList.indexOf('Test Client') >= 0);

  // Keys are made at the bottom of the chain. A tier above the seller reads the
  // list and hands the request down; /generate_key refuses it even when the form
  // is posted by hand.
  const keysBefore = store.scalar(
    'SELECT COUNT(*) FROM keys WHERE created_by_id = ?', [userOf(KPT_SELLER).id]
  );
  await up.post('/generate_key', { days: '30', name: 'KPTDENIED' });
  check('the parent is told only a seller may create', true,
    /Only a seller can create a key/.test((await up.get('/all_key')).html));
  check('and no key appeared', null, keyOf('KPTDENIED'));
  check('the seller’s key count is unchanged', keysBefore, store.scalar(
    'SELECT COUNT(*) FROM keys WHERE created_by_id = ?', [userOf(KPT_SELLER).id]
  ));

  // The same three jobs, seen from the outside: the generator is the seller's
  // card, delete and extend are the controller's controls.
  check('the seller page carries the generator', true,
    ownList.indexOf('action="/generate_key"') >= 0);
  check('the generator is the Generate New Key modal', true,
    ownList.indexOf('id="modal-generate-key"') >= 0);
  check('the only package is the controller’s validity', true,
    ownList.indexOf('FULL VERSION (' + sellerDays + ' Days)') >= 0);
  check('and no delete form', false, ownList.indexOf('action="/delete_key"') >= 0);
  check('and no extend form', false, ownList.indexOf('action="/extend_id"') >= 0);
  check('the client-name editor is on the page', true, ownList.indexOf('action="/update_client_name"') >= 0);
  check('and no page can rename the key', false, ownList.indexOf('action="/update_name"') >= 0);

  // A seller sees only its own account and the super seller above it; the
  // developer, super master, master and admin tiers stay off its table.
  check('the seller table hides the higher tiers', 0,
    ['Developer', 'Super Master Admin', 'Master Admin', 'Admin']
      .filter(l => ownList.indexOf('<th>' + l + '</th>') >= 0).length);
  check('and keeps the super seller and itself', 2,
    ['Super Seller', 'Seller'].filter(l => ownList.indexOf('<th>' + l + '</th>') >= 0).length);

  const upPage = (await up.get('/all_key')).html;
  check('the parent page carries no generator', false, upPage.indexOf('action="/generate_key"') >= 0);
  check('the parent page carries no delete form', false, upPage.indexOf('action="/delete_key"') >= 0);
  check('the parent page carries no extend form', false, upPage.indexOf('action="/extend_id"') >= 0);
  check('the parent can edit the client name', true, upPage.indexOf('action="/update_client_name"') >= 0);

  const midPage = (await admin.get('/all_key')).html;
  check('the admin in between carries no generator', false, midPage.indexOf('action="/generate_key"') >= 0);
  check('the admin in between carries no delete form', false, midPage.indexOf('action="/delete_key"') >= 0);
  check('the admin in between carries no extend form', false, midPage.indexOf('action="/extend_id"') >= 0);
  check('the admin in between can edit the client name', true, midPage.indexOf('action="/update_client_name"') >= 0);

  const ctrlPage = (await ctrl.get('/all_key')).html;
  check('the controller page carries the delete form', true, ctrlPage.indexOf('action="/delete_key"') >= 0);
  check('the controller page carries the extend form', true, ctrlPage.indexOf('action="/extend_id"') >= 0);
  check('and still no generator', false, ctrlPage.indexOf('action="/generate_key"') >= 0);
  check('the controller can edit the client name too', true, ctrlPage.indexOf('action="/update_client_name"') >= 0);
  check('the controller is the only one with a trash control', true, ctrlPage.indexOf('fa-trash') >= 0);
  check('and the parent has none', false, upPage.indexOf('fa-trash') >= 0);
  check('the seller has none either', false, ownList.indexOf('fa-trash') >= 0);
  check('nobody can rename a key from here', false,
    ctrlPage.indexOf('action="/update_name"') >= 0);
  check('the controller page carries the seller-validity form', true,
    ctrlPage.indexOf('action="/set_seller_days"') >= 0);
  check('the seller page does not', false, ownList.indexOf('action="/set_seller_days"') >= 0);
  check('the parent page does not', false, upPage.indexOf('action="/set_seller_days"') >= 0);

  // The controller's one-click Key Hierarchy: every level of this key's own
  // chain, by name, in a single modal. The tiers below get no such control.
  const hAt1 = ctrlPage.indexOf('id="modal-hierarchy' + k1.id + '"');
  check('the controller gets the one-click hierarchy', true, hAt1 >= 0);
  const hBlock1 = ctrlPage.slice(hAt1, ctrlPage.indexOf('</table>', hAt1));
  check('the hierarchy carries the key name', true, hBlock1.indexOf('KPTKEY1') >= 0);
  check('the hierarchy names every level of this key', true,
    ['LUCKYDEV', 'LUCKYSUPERMASTER', 'YOGIMASTER', KPT_ADMIN, KPT_SUPER, KPT_SELLER]
      .every(function (n) { return hBlock1.indexOf(n) >= 0; }));
  check('the seller gets no hierarchy modal', false, ownList.indexOf('id="modal-hierarchy') >= 0);
  check('and no hierarchy button', false, ownList.indexOf('fa-sitemap') >= 0);

  // ================================================== 2. only the direct parent bills
  console.log('\n2. the grandparent cannot bill it; only the direct parent can');
  await admin.post('/mark_key_paid', { key_id: String(k1.id) });
  check('the attempt left it unpaid', 0, keyOf('KPTKEY1').has_paid);
  check('and raised no bill', 0, billRows(KPT_SELLER).length);

  console.log('\n3. the parent marks it Paid and the due appears');
  const upList = (await up.get('/all_key')).html;
  check('the parent sees Mark Paid', true, upList.indexOf('/mark_key_paid') >= 0);
  check('the control names who and how much', true, new RegExp('bills ' + KPT_SELLER).test(upList));
  await up.post('/mark_key_paid', { key_id: String(k1.id) });
  check('key is Paid', 1, keyOf('KPTKEY1').has_paid);
  check('due grew by the seller price', panelDue + price, dueOf(KPT_SELLER));

  const rows1 = billRows(KPT_SELLER);
  check('one Due record', 1, rows1.length);
  check('Due record amount', price, Number(rows1[0] && rows1[0].amount));
  check('Due record names the key', 'KPTKEY1', rows1[0] && rows1[0].key_name);
  check('Due record is open', 'Pending', rows1[0] && rows1[0].status);
  check('Due record is owed to the parent', userOf(KPT_SUPER).id, rows1[0] && rows1[0].receiver_id);

  const hist1 = (await sell.get('/payment_history')).html;
  check('history shows the Due record', true, hasBadge(hist1, 'warning', '𝐃𝐮𝐞'));
  check('transaction shows it too', true, hasBadge((await sell.get('/transaction')).html, 'warning', '𝐃𝐮𝐞'));
  check('the parent board lists the owing panel', true, (await up.get('/payment_history')).html.indexOf(KPT_SELLER) >= 0);

  // ======================================================== 4. the parent receives
  console.log('\n4. the parent receives it; the Due record becomes the Paid record');
  await up.post('/accept_payment', { sender_id: String(userOf(KPT_SELLER).id), amount: String(price) });
  const rows2 = billRows(KPT_SELLER);
  check('bill is settled', 'Success', rows2[0] && rows2[0].status);
  check('due back to where it started', panelDue, dueOf(KPT_SELLER));
  check('still the one record for that key', 1, rows2.length);

  const hist2 = (await sell.get('/payment_history')).html;
  check('history now reads Paid', true, hasBadge(hist2, 'success', '𝐏𝐚𝐢𝐝 &#9989;'));
  check('the Due badge is gone', false, hasBadge(hist2, 'warning', '𝐃𝐮𝐞'));
  check('transaction agrees', true, hasBadge((await sell.get('/transaction')).html, 'success', '𝐏𝐚𝐢𝐝'));

  console.log('\n5. marking an already Paid key does not bill twice');
  await up.post('/mark_key_paid', { key_id: String(k1.id) });
  check('still one record', 1, billRows(KPT_SELLER).length);
  check('due unchanged', panelDue, dueOf(KPT_SELLER));

  // ======================================== 6. client name in, key name fixed out
  console.log('\n6. every login may correct the client name; nobody may rename the key');
  await sell.post('/update_client_name', { key_id: String(k1.id), client_name: 'Client By Seller' });
  check('the seller edited the client name', 'Client By Seller', (keyOf('KPTKEY1') || {}).client_name);
  check('and the key name did not move', 'KPTKEY1', (keyOf('KPTKEY1') || {}).key_name);

  // One turn per tier above the seller, in chain order, each with its own login.
  const clientTiers = [
    ['LUCKYDEV', 'demo123', 'Client By Developer'],
    ['LUCKYSUPERMASTER', 'demo123', 'Client By Super Master'],
    ['YOGIMASTER', 'demo123', 'Client By Master'],
    [KPT_ADMIN, KPT_PASS, 'Client By Admin'],
    [KPT_SUPER, KPT_PASS, 'Client By Super Seller']
  ];
  for (const [who, pass, label] of clientTiers) {
    const tierJar = jar();
    await tierJar.enter(who, pass);
    await tierJar.post('/update_client_name', { key_id: String(k1.id), client_name: label });
    check(who + ' edited the client name', label, (keyOf('KPTKEY1') || {}).client_name);
  }
  await ctrl.post('/update_client_name', { key_id: String(k1.id), client_name: 'Client By Controller' });
  check('the controller edited it too', 'Client By Controller', (keyOf('KPTKEY1') || {}).client_name);
  check('the key name still never moved', 'KPTKEY1', (keyOf('KPTKEY1') || {}).key_name);

  // The old rename endpoint no longer exists, so a hand-made request cannot
  // change key_name either. A key name is the key's identity, not a label.
  const hack = await sell.post('/update_name', { key_id: String(k1.id), name: 'HACKEDKEY' });
  check('the old rename route is gone', 404, hack.status);
  check('the key name is untouched', 'KPTKEY1', (keyOf('KPTKEY1') || {}).key_name);
  check('and no key took the old name', null, keyOf('HACKEDKEY'));

  // ========================================= 7. deleting is the controller's alone
  console.log('\n7. only the controller can delete a key');
  await sell.post('/delete_key', { key_id: String(k1.id) });
  check('the creator cannot delete its own key', 'KPTKEY1', (keyOf('KPTKEY1') || {}).key_name);
  const sellList = (await sell.get('/all_key')).html;
  check('its page carries no trash control', false, sellList.indexOf('fa-trash') >= 0);
  check('and the route still says why', true, sellList.indexOf('Only the controller can delete keys') >= 0);
  check('the edited client name is still on the row', true, sellList.indexOf('Client By Controller') >= 0);

  await up.post('/delete_key', { key_id: String(k1.id) });
  check('the parent cannot delete it either', 'KPTKEY1', (keyOf('KPTKEY1') || {}).key_name);
  check('the parent is told why', true,
    /Only the controller can delete keys/.test((await up.get('/all_key')).html));

  await admin.post('/delete_key', { key_id: String(k1.id) });
  check('the grandparent cannot either', 'KPTKEY1', (keyOf('KPTKEY1') || {}).key_name);

  await ctrl.post('/delete_key', { key_id: String(k1.id) });
  check('the controller deleted it', null, keyOf('KPTKEY1'));
  check('the bill row stays for the record', 1, billRows(KPT_SELLER).length);

  // ========================================= 8. validity is the controller's alone
  console.log('\n8. Edit Validity: the controller sets exact days, up or down, and every change is kept');
  // The posted 5 is ignored: a seller's key always runs for the controller's
  // seller-key validity, never a length the seller picked.
  await sell.post('/generate_key', { days: '5', name: 'KPTKEY2' });
  const k2 = keyOf('KPTKEY2');
  check('a second key exists', 'KPTKEY2', k2 && k2.key_name);
  check('it starts at the controller’s validity, not the posted 5', sellerDays, k2 && Number(k2.days));
  check('a key with no registered MAC prints a dash', true,
    /<span class="text-muted" title="[^"]+">—<\/span>/.test((await sell.get('/all_key')).html));

  await sell.post('/edit_validity', { days: '10', key_id: String(k2.id) });
  check('the seller cannot set its own days', sellerDays, Number((keyOf('KPTKEY2') || {}).days));
  await up.post('/edit_validity', { days: '10', key_id: String(k2.id) });
  check('the parent cannot either', sellerDays, Number((keyOf('KPTKEY2') || {}).days));
  await admin.post('/edit_validity', { days: '10', key_id: String(k2.id) });
  check('nor the panel above that', sellerDays, Number((keyOf('KPTKEY2') || {}).days));
  check('and the seller is told only the controller may', true,
    /Only the controller can edit a key/.test((await sell.get('/all_key')).html));

  // The old per-key extend post no longer adds days; Edit Validity replaced it.
  await ctrl.post('/extend_id', { days: '10', id: String(k2.id) });
  check('the old per-key extend post is refused', sellerDays, Number((keyOf('KPTKEY2') || {}).days));

  // Increase: the entered number becomes the validity, expiry = today + days.
  await ctrl.post('/edit_validity', { days: String(sellerDays + 10), key_id: String(k2.id) });
  check('the controller raised it to the exact number', sellerDays + 10, Number((keyOf('KPTKEY2') || {}).days));
  check('and the page says so', true,
    /KPTKEY2 validity set to/.test((await ctrl.get('/all_key')).html));
  check('the new expiry is today + the new days', true,
    Math.abs((new Date(keyOf('KPTKEY2').expire_date) - Date.now()) / 86400000 - (sellerDays + 10)) < 0.02);

  // Decrease: the same control pulls the expiry back in.
  await ctrl.post('/edit_validity', { days: '5', key_id: String(k2.id) });
  check('the controller lowered it to 5', 5, Number((keyOf('KPTKEY2') || {}).days));
  check('the expiry came down with it', true,
    Math.abs((new Date(keyOf('KPTKEY2').expire_date) - Date.now()) / 86400000 - 5) < 0.02);
  await ctrl.post('/edit_validity', { days: '0', key_id: String(k2.id) });
  check('zero days is refused', 5, Number((keyOf('KPTKEY2') || {}).days));

  // Both changes are preserved, oldest first, with who and what.
  const vlog = store.all('SELECT * FROM validity_history WHERE key_id = ? ORDER BY id', [k2.id]);
  check('both changes are in the history', 2, vlog.length);
  check('the increase recorded old and new days', sellerDays + '|' + (sellerDays + 10),
    vlog[0].old_days + '|' + vlog[0].new_days);
  check('the decrease recorded old and new days', (sellerDays + 10) + '|5',
    vlog[1].old_days + '|' + vlog[1].new_days);
  check('the history names the controller', CONTROLLER.user, vlog[0].username);
  check('the history names the key', 'KPTKEY2', vlog[0].key_name);
  check('the history keeps the old expiry too', k2.expire_date, vlog[0].old_expire);

  // The controls sit on the controller's rows alone.
  const ctrlPage8 = (await ctrl.get('/all_key')).html;
  check('the controller row has Edit Validity', true, ctrlPage8.indexOf('modal-validity' + k2.id) >= 0);
  check('the controller row has Validity History', true, ctrlPage8.indexOf('modal-vhist' + k2.id) >= 0);
  check('the history modal prints the change', true, ctrlPage8.indexOf('&rarr; <strong>5</strong>') >= 0);
  const sellPage8 = (await sell.get('/all_key')).html;
  check('the seller has no Edit Validity', false, sellPage8.indexOf('modal-validity') >= 0);
  check('the seller has no Validity History', false, sellPage8.indexOf('modal-vhist') >= 0);

  // A level with no account reads Not Assigned; the other names stay visible.
  // Only this test's own key is touched, and the branch leaves at cleanup.
  store.run('UPDATE keys SET master_admin_id = NULL WHERE id = ?', [k2.id]);
  const hierPage = (await ctrl.get('/all_key')).html;
  const hAt2 = hierPage.indexOf('id="modal-hierarchy' + k2.id + '"');
  const hBlock2 = hierPage.slice(hAt2, hierPage.indexOf('</table>', hAt2));
  check('the empty level reads Not Assigned', true, hBlock2.indexOf(boldText('Not Assigned')) >= 0);
  check('the missing master name is not printed', false, hBlock2.indexOf('YOGIMASTER') >= 0);
  check('every other level still shows its name', true,
    ['LUCKYDEV', 'LUCKYSUPERMASTER', KPT_ADMIN, KPT_SUPER, KPT_SELLER]
      .every(function (n) { return hBlock2.indexOf(n) >= 0; }));

  // ============================ 9. the controller sets the seller-key validity
  console.log('\n9. the controller sets the seller validity; sellers cannot exceed it');
  const validityRow = store.get("SELECT value FROM settings WHERE key = 'panel_days'");
  const originalValidity = validityRow ? validityRow.value : null;

  await ctrl.post('/set_seller_days', { days: '40' });
  check('the controller set it to 40', '40',
    store.scalar("SELECT value FROM settings WHERE key = 'panel_days'"));
  check('and the page confirms', true,
    /Seller key validity set to 40 day\(s\)/.test((await ctrl.get('/all_key')).html));
  check('the seller’s package now reads 40', true,
    (await sell.get('/all_key')).html.indexOf('FULL VERSION (40 Days)') >= 0);

  // A hand-made post asking for 90 days still gets a 40-day key.
  await sell.post('/generate_key', { days: '90', name: 'KPTKEY3' });
  check('a 90-day request is clamped to the limit', 40, Number((keyOf('KPTKEY3') || {}).days));

  // A seller cannot move the limit itself.
  await sell.post('/set_seller_days', { days: '60' });
  check('the seller cannot change the limit', '40',
    store.scalar("SELECT value FROM settings WHERE key = 'panel_days'"));
  check('and is told only the controller may', true,
    /Only the controller can set the seller key validity/.test((await sell.get('/all_key')).html));

  // Put the owner's value back exactly as it was, row or no row.
  if (originalValidity === null) {
    store.run("DELETE FROM settings WHERE key = 'panel_days'");
  } else {
    store.run("UPDATE settings SET value = ? WHERE key = 'panel_days'", [originalValidity]);
  }
  check('the original validity is restored', originalValidity,
    (store.get("SELECT value FROM settings WHERE key = 'panel_days'") || {}).value || null);

  // ============================================== 10. gift keys, free and paid
  console.log('\n10. gift keys: free, born Paid, controller-managed, transferable');
  const dueBeforeGift = dueOf(KPT_SELLER);
  const due2BeforeGift = dueOf(KPT_SELLER2);
  await ctrl.post('/create_gift_key', { seller_name: KPT_SELLER, days: '15', name: 'KPTGIFT1' });
  const g1 = keyOf('KPTGIFT1');
  check('the gift key exists', 'KPTGIFT1', g1 && g1.key_name);
  check('it is flagged a gift', 1, g1 && g1.is_gift);
  check('it is born Paid', 1, g1 && g1.has_paid);
  check('its validity is what the controller asked', 15, g1 && Number(g1.days));
  check('its client label is GIFT KEY', 'GIFT KEY', g1 && g1.client_name);
  check('it landed on the named seller', userOf(KPT_SELLER).id, g1 && g1.created_by_id);
  check('no due raised on the seller', dueBeforeGift, dueOf(KPT_SELLER));
  check('no bill row for the gift', 0,
    billRows(KPT_SELLER).filter(r => r.key_name === 'KPTGIFT1').length);

  // What the seller panel shows for the gift row.
  const giftList = (await sell.get('/all_key')).html;
  const gi = giftList.indexOf('KPTGIFT1');
  const grow = giftList.slice(gi, giftList.indexOf('</tr>', gi));
  check('the seller sees the gift row', true, gi >= 0);
  check('the client column reads GIFT KEY', true, grow.indexOf(boldText('GIFT KEY')) >= 0);
  check('the expiry date is shown', true, grow.indexOf(g1.expire_date) >= 0);
  check('the validity is shown', true, grow.indexOf('<td>15</td>') >= 0);
  check('the status reads Paid', true, /𝐏𝐚𝐢𝐝/.test(grow));
  check('the gift row keeps the normal reset/activate controls', true, grow.indexOf('status_update') >= 0);
  check('the gift row keeps Add IP', true, grow.indexOf('modal-ip' + g1.id) >= 0);
  check('no client edit on the gift row', false, grow.indexOf('modal-client') >= 0);
  check('no delete on the gift row for the seller', false, grow.indexOf('modal-delete-name') >= 0);
  check('no edit validity on the gift row for the seller', false, grow.indexOf('modal-validity') >= 0);
  check('no lock on the gift row', false, grow.indexOf('fa-lock') >= 0);

  // The controller keeps the management controls on the same row. Search inside
  // the table body: the create flash above the table also names the key, and a
  // naive first-match would slice the flash instead of the row.
  const ctrlGift = (await ctrl.get('/all_key')).html;
  const ctrlBody = ctrlGift.slice(ctrlGift.indexOf('<tbody>'));
  const ci = ctrlBody.indexOf('KPTGIFT1');
  const crow = ctrlBody.slice(ci, ctrlBody.indexOf('</tr>', ci));
  check('the controller has transfer on the gift row', true, crow.indexOf('modal-gift-transfer' + g1.id) >= 0);
  check('the controller has delete on the gift row', true, crow.indexOf('modal-delete-name' + g1.id) >= 0);

  // Transfer to the second seller by name; money does not move.
  await ctrl.post('/transfer_gift_key', { key_id: String(g1.id), seller_name: KPT_SELLER2 });
  check('the gift moved to the second seller', userOf(KPT_SELLER2).id, keyOf('KPTGIFT1').created_by_id);
  check('it is still a gift', 1, keyOf('KPTGIFT1').is_gift);
  check('it is still Paid', 1, keyOf('KPTGIFT1').has_paid);
  check('the second seller now sees it', true, (await sell2.get('/all_key')).html.indexOf('KPTGIFT1') >= 0);
  check('the first seller no longer sees it', false, (await sell.get('/all_key')).html.indexOf('KPTGIFT1') >= 0);
  check('no due on either seller after the move', dueBeforeGift + '|' + due2BeforeGift,
    dueOf(KPT_SELLER) + '|' + dueOf(KPT_SELLER2));

  // Nobody below the controller can create or transfer a gift, and marking a
  // gift Paid raises nothing.
  await sell.post('/create_gift_key', { seller_name: KPT_SELLER, days: '10', name: 'KPTGIFTX' });
  check('a seller cannot create a gift', null, keyOf('KPTGIFTX'));
  await sell2.post('/transfer_gift_key', { key_id: String(g1.id), seller_name: KPT_SELLER });
  check('a seller cannot transfer a gift', userOf(KPT_SELLER2).id, keyOf('KPTGIFT1').created_by_id);
  await up.post('/mark_key_paid', { key_id: String(g1.id) });
  check('marking a gift Paid raises no bill', 0,
    billRows(KPT_SELLER2).filter(r => r.key_name === 'KPTGIFT1').length);

  // ============================================== 11. mass delete, the same rule
  console.log('\n11. mass delete is the controller’s too');
  await sell.get('/status_update?ac_id=' + k2.id);              // flip it to deactive
  check('key is deactive', 'deactive', keyOf('KPTKEY2').status);

  await sell.post('/all_key', { mass_delete_submit: '1', delete_type: 'deactive', admin_pass: 'LOVE' });
  check('the seller’s bulk delete was refused', 'KPTKEY2', (keyOf('KPTKEY2') || {}).key_name);
  check('and the flash says why', true,
    /Only the controller can delete keys/.test((await sell.get('/all_key')).html));

  await up.post('/all_key', { mass_delete_submit: '1', delete_type: 'deactive', admin_pass: 'LOVE' });
  check('the parent’s bulk delete was refused', 'KPTKEY2', (keyOf('KPTKEY2') || {}).key_name);
  check('with the same reason', true,
    /Only the controller can delete keys/.test((await up.get('/all_key')).html));

  // The controller's bulk delete sweeps every deactive key in its scope, which
  // is the whole database, so it only runs when this test's key is the only one
  // that would go. The password gate is still exercised either way.
  await ctrl.post('/all_key', { mass_delete_submit: '1', delete_type: 'deactive', admin_pass: 'wrong' });
  check('the controller still has to clear the gate', 'KPTKEY2', (keyOf('KPTKEY2') || {}).key_name);
  check('and is told the password was wrong', true,
    /password did not match/.test((await ctrl.get('/all_key')).html));

  const foreignDeactive = store.scalar(
    "SELECT COUNT(*) FROM keys WHERE status = 'deactive' AND key_name NOT LIKE 'KPT%'"
  );
  if (foreignDeactive) {
    console.log('  skip  controller bulk delete: ' + foreignDeactive +
      ' deactive key(s) outside KPT would be swept along');
  } else {
    await ctrl.post('/all_key', { mass_delete_submit: '1', delete_type: 'deactive', admin_pass: 'LOVE' });
    check('the controller’s bulk delete removed it', null, keyOf('KPTKEY2'));
  }

  // ================================== 12. renew: unpaid now, days after payment
  console.log('\n12. renew: the seller flips it UnPaid; the parent’s Paid click adds the days');
  // A fresh Paid key of this branch's own, settled like any other bill.
  await sell.post('/generate_key', { days: '30', name: 'KPTKEYR', client_name: 'Renew Client' });
  const kr = keyOf('KPTKEYR');
  check('the renew-test key exists', 'KPTKEYR', kr && kr.key_name);
  await up.post('/mark_key_paid', { key_id: String(kr.id) });
  await up.post('/accept_payment', { sender_id: String(userOf(KPT_SELLER).id), amount: String(price) });
  check('it starts Paid and settled', '1|' + panelDue, keyOf('KPTKEYR').has_paid + '|' + dueOf(KPT_SELLER));

  // Helper: one row of the seller table, sliced from the body so a flash that
  // names the key can never stand in for the row itself.
  async function sellerRow(name) {
    const html = (await sell.get('/all_key')).html;
    const body = html.slice(html.indexOf('<tbody>'));
    const i = body.indexOf(name);
    return i < 0 ? '' : body.slice(i, body.indexOf('</tr>', i));
  }

  // Far from expiry: no button, and a hand-made post is refused.
  check('no Renew button while plenty of days are left', false,
    (await sellerRow('KPTKEYR')).indexOf('/renew_key') >= 0);
  await sell.post('/renew_key', { key_id: String(kr.id) });
  check('renewing early is refused', '1|0', keyOf('KPTKEYR').has_paid + '|' + keyOf('KPTKEYR').renew_pending);
  check('and the flash says the 3-day rule', true,
    /3 days or less/.test((await sell.get('/all_key')).html));

  // Only a seller may renew, only a Paid key, and never a gift.
  await up.post('/renew_key', { key_id: String(kr.id) });
  check('the parent cannot renew', '1|0', keyOf('KPTKEYR').has_paid + '|' + keyOf('KPTKEYR').renew_pending);
  check('and is told only a seller may', true,
    /Only a seller can renew/.test((await up.get('/all_key')).html));
  await sell.post('/renew_key', { key_id: String(keyOf('KPTKEY3').id) });
  check('an UnPaid key cannot be renewed', 0, keyOf('KPTKEY3').has_paid);
  await sell2.post('/renew_key', { key_id: String(keyOf('KPTGIFT1').id) });
  check('a gift key cannot be renewed', '1|0',
    keyOf('KPTGIFT1').has_paid + '|' + keyOf('KPTGIFT1').renew_pending);
  check('and the flash says gifts are free', true,
    /gift key/.test((await sell2.get('/all_key')).html));

  // Bring the key inside the 3-day window, the one place the button appears.
  store.run("UPDATE keys SET expire_date = datetime('now','localtime','+2 days') WHERE id = ?", [kr.id]);
  const nearRow = await sellerRow('KPTKEYR');
  check('the Renew button appears at 2 days left', true, nearRow.indexOf('/renew_key') >= 0);
  check('the parent never gets the button', false,
    (await up.get('/all_key')).html.indexOf('/renew_key') >= 0);

  const daysBefore = Number(keyOf('KPTKEYR').days);
  const expireBefore = keyOf('KPTKEYR').expire_date;
  const billsBefore = billRows(KPT_SELLER).length;
  await sell.post('/renew_key', { key_id: String(kr.id) });
  const krPending = keyOf('KPTKEYR');
  check('the key flips to UnPaid at once', 0, krPending.has_paid);
  check('and waits for its renewal payment', 1, krPending.renew_pending);
  check('no days are granted yet', daysBefore, Number(krPending.days));
  check('the expiry has not moved', expireBefore, krPending.expire_date);
  check('no bill raised by the renew click itself', billsBefore, billRows(KPT_SELLER).length);
  check('the due has not moved', panelDue, dueOf(KPT_SELLER));

  const pendRow = await sellerRow('KPTKEYR');
  check('the row now reads Renew pending', true, pendRow.indexOf(boldText('Renew pending')) >= 0);
  check('and offers no second Renew click', false, pendRow.indexOf('/renew_key') >= 0);
  await sell.post('/renew_key', { key_id: String(kr.id) });
  check('a second renew is refused', 1, keyOf('KPTKEYR').renew_pending);

  // The grandparent still cannot bill; only the direct parent settles a renew.
  await admin.post('/mark_key_paid', { key_id: String(kr.id) });
  check('the grandparent cannot settle the renew', '0|1',
    keyOf('KPTKEYR').has_paid + '|' + keyOf('KPTKEYR').renew_pending);

  await up.post('/mark_key_paid', { key_id: String(kr.id) });
  const krDone = keyOf('KPTKEYR');
  check('the parent’s Paid click marks it Paid', 1, krDone.has_paid);
  check('and clears the pending flag', 0, krDone.renew_pending);
  check('the validity grew by the seller days', daysBefore + sellerDays, Number(krDone.days));
  const renewVlog = store.all('SELECT * FROM validity_history WHERE key_id = ? ORDER BY id', [kr.id]);
  check('the renewal extension is in the validity history', 1, renewVlog.length);
  check('it is tagged a renew', 'renew', renewVlog[0] && renewVlog[0].note);
  check('and credited to the parent who marked Paid', KPT_SUPER, renewVlog[0] && renewVlog[0].username);
  check('the expiry moved out by the same days', true,
    (new Date(krDone.expire_date) - new Date(expireBefore)) / 86400000 >= sellerDays - 0.01);
  check('the due grew by the seller price', panelDue + price, dueOf(KPT_SELLER));

  const renewBills = billRows(KPT_SELLER).filter(r => r.key_name === 'KPTKEYR');
  check('two bills for the key: first sale and renewal', 2, renewBills.length);
  const rb = renewBills[renewBills.length - 1];
  check('the renewal bill is tagged a renew', 1, rb && Number(rb.is_renew));
  check('the first-sale bill is not', 0, Number(renewBills[0].is_renew));
  check('the renewal bill is open', 'Pending', rb && rb.status);
  check('it is owed to the parent', userOf(KPT_SUPER).id, rb && rb.receiver_id);
  check('and carries the seller price', price, rb && Number(rb.amount));

  // The whole trail: key name plus a Renew badge on both money pages.
  const renewHist = (await sell.get('/payment_history')).html;
  const renewTrans = (await sell.get('/transaction')).html;
  check('payment history names the renewed key', true, renewHist.indexOf('KPTKEYR') >= 0);
  check('payment history carries the Renew badge', true, hasBadge(renewHist, 'info', boldText('Renew')));
  check('transaction names it too', true, renewTrans.indexOf('KPTKEYR') >= 0);
  check('transaction carries the Renew badge', true, hasBadge(renewTrans, 'info', boldText('Renew')));
  check('the parent’s board shows the renewal', true,
    (await up.get('/payment_history')).html.indexOf('KPTKEYR') >= 0);

  // The parent receives the renewal money like any other due.
  await up.post('/accept_payment', { sender_id: String(userOf(KPT_SELLER).id), amount: String(price) });
  check('the renewal bill settles', 'Success',
    billRows(KPT_SELLER).filter(r => r.key_name === 'KPTKEYR').pop().status);
  check('the due is back to where it started', panelDue, dueOf(KPT_SELLER));

  // ===================================== 12b. complete key transfer, whole account
  console.log('\n12b. Complete Key Transfer: the key AND its whole account move to the new panel');
  // A fresh key with a live (Pending) due, a MAC reset and a validity change, so
  // every record category has something to carry. It is made and billed inside
  // this branch only.
  await sell.post('/generate_key', { days: '30', name: 'KPTKEYT', mac: 'AA:BB:CC:DD:EE:99', client_name: 'Transfer Client' });
  const kt = keyOf('KPTKEYT');
  check('the transfer-test key exists', 'KPTKEYT', kt && kt.key_name);
  await up.post('/mark_key_paid', { key_id: String(kt.id) });   // raises a Pending due
  await ctrl.get('/status_update?r_id=' + kt.id);              // logs one MAC reset
  await ctrl.post('/edit_validity', { days: String(sellerDays + 3), key_id: String(kt.id) });

  const acctBefore = {
    bills: store.scalar('SELECT COUNT(*) FROM payments WHERE key_id = ? AND sender_id = ?', [kt.id, kt.created_by_id]),
    pending: store.scalar("SELECT COALESCE(SUM(amount),0) FROM payments WHERE key_id = ? AND sender_id = ? AND kind = 'due' AND status = 'Pending'", [kt.id, kt.created_by_id]),
    resets: store.scalar('SELECT COUNT(*) FROM key_resets WHERE key_id = ?', [kt.id]),
    validity: store.scalar('SELECT COUNT(*) FROM validity_history WHERE key_id = ?', [kt.id])
  };
  check('the owner account has one bill', 1, acctBefore.bills);
  check('the bill is a pending due of the seller price', price, Number(acctBefore.pending));
  // The Paid click bills the WHOLE chain: one due per level from the seller up
  // to (never including) the controller.
  let depth = 0;
  for (let n = userOf(KPT_SELLER); n && n.role !== 'controller'; n = n.parent_id ? store.get('SELECT * FROM users WHERE id = ?', [n.parent_id]) : null) depth++;
  check('every chain level carries a bill', depth, store.scalar("SELECT COUNT(*) FROM payments WHERE key_id = ? AND kind = 'due'", [kt.id]));
  check('the reset trail has one row', 1, acctBefore.resets);
  check('the validity trail has one row', 1, acctBefore.validity);

  const dueSL = dueOf(KPT_SELLER);       // carries the pending due now
  const dueSL2 = dueOf(KPT_SELLER2);     // owes nothing yet
  check('the old seller carries the pending due', panelDue + price, dueSL);

  // The transfer control is the controller's alone, on ordinary rows.
  const ctrlT = (await ctrl.get('/all_key')).html;
  check('the controller row has the Transfer modal', true, ctrlT.indexOf('id="modal-transfer' + kt.id + '"') >= 0);
  check('the transfer modal previews the account', true, ctrlT.indexOf(boldText('Account that will move')) >= 0);
  check('the transfer modal names the current panel', true,
    ctrlT.slice(ctrlT.indexOf('id="modal-transfer' + kt.id + '"')).indexOf(KPT_SELLER) >= 0);
  check('the seller has no Transfer control', false, (await sell.get('/all_key')).html.indexOf('/transfer_key') >= 0);
  check('the parent has none either', false, (await up.get('/all_key')).html.indexOf('/transfer_key') >= 0);

  // Refusals first: a tier below the controller, a bad name, the controller
  // itself, and the key's current owner all leave the key where it is.
  await sell.post('/transfer_key', { key_id: String(kt.id), target_name: KPT_SELLER2 });
  check('a seller cannot transfer', userOf(KPT_SELLER).id, keyOf('KPTKEYT').created_by_id);
  check('and is told only the controller may', true,
    /Only the controller can transfer a key/.test((await sell.get('/all_key')).html));
  await ctrl.post('/transfer_key', { key_id: String(kt.id), target_name: 'KPTNOPE' });
  check('an unknown panel is refused', userOf(KPT_SELLER).id, keyOf('KPTKEYT').created_by_id);
  await ctrl.post('/transfer_key', { key_id: String(kt.id), target_name: CONTROLLER.user });
  check('the controller itself is not a target', userOf(KPT_SELLER).id, keyOf('KPTKEYT').created_by_id);
  await ctrl.post('/transfer_key', { key_id: String(kt.id), target_name: KPT_SELLER });
  check('transferring to the current owner does nothing', userOf(KPT_SELLER).id, keyOf('KPTKEYT').created_by_id);
  check('and no transfer was logged for the refusals', 0,
    store.scalar("SELECT COUNT(*) FROM transfer_history WHERE key_name = 'KPTKEYT'"));

  // The real move: KPTSL -> KPTSL2, with the entire account.
  await ctrl.post('/transfer_key', { key_id: String(kt.id), target_name: KPT_SELLER2 });
  const ktAfter = keyOf('KPTKEYT');
  check('the key now belongs to the new panel', userOf(KPT_SELLER2).id, ktAfter.created_by_id);
  check('the key keeps its name', 'KPTKEYT', ktAfter.key_name);
  check('the key keeps its client name', 'Transfer Client', ktAfter.client_name);
  check('the key keeps its validity', sellerDays + 3, Number(ktAfter.days));
  check('the key stays Paid', 1, ktAfter.has_paid);

  // The OWNER's bill row was re-pointed, not copied: one row, new sender and
  // receiver. The chain bills above it are those panels' own debts and stay.
  const tBills = store.all('SELECT * FROM payments WHERE key_id = ? AND sender_id = ? ORDER BY id', [kt.id, userOf(KPT_SELLER2).id]);
  check('still exactly one owner bill — no duplicate', 1, tBills.length);
  check('the bill now reads the new panel as sender', userOf(KPT_SELLER2).id, tBills[0].sender_id);
  check('and the new panel’s parent as receiver', userOf(KPT_SUPER).id, tBills[0].receiver_id);
  check('the bill is still the open due', 'Pending', tBills[0].status);
  check('the ancestor bills stayed with their own panels', depth - 1, store.scalar(
    'SELECT COUNT(*) FROM payments WHERE key_id = ? AND sender_id <> ?', [kt.id, userOf(KPT_SELLER2).id]));

  // The pending obligation moved off the old balance and onto the new one.
  check('the old seller’s due came back down', panelDue, dueOf(KPT_SELLER));
  check('the new seller now carries the pending due', dueSL2 + price, dueOf(KPT_SELLER2));

  // The old panel's histories lose the key; the new panel's gain it.
  check('the old seller has no bill for the key', 0, billRows(KPT_SELLER).filter(r => r.key_name === 'KPTKEYT').length);
  check('the new seller has the bill', 1, billRows(KPT_SELLER2).filter(r => r.key_name === 'KPTKEYT').length);
  check('the old seller’s payment history lost it', false, (await sell.get('/payment_history')).html.indexOf('KPTKEYT') >= 0);
  check('the old seller’s transaction lost it', false, (await sell.get('/transaction')).html.indexOf('KPTKEYT') >= 0);
  check('the new seller’s payment history shows it', true, (await sell2.get('/payment_history')).html.indexOf('KPTKEYT') >= 0);
  check('the new seller’s transaction shows it', true, (await sell2.get('/transaction')).html.indexOf('KPTKEYT') >= 0);
  check('the old seller’s key list lost it', false, (await sell.get('/all_key')).html.indexOf('KPTKEYT') >= 0);
  check('the new seller’s key list shows it', true, (await sell2.get('/all_key')).html.indexOf('KPTKEYT') >= 0);

  // Reset and validity trails hang off key_id, so they travelled untouched.
  check('the reset trail came along', 1, store.scalar('SELECT COUNT(*) FROM key_resets WHERE key_id = ?', [kt.id]));
  check('the validity trail came along', 1, store.scalar('SELECT COUNT(*) FROM validity_history WHERE key_id = ?', [kt.id]));

  // The controller's transfer history records the whole move.
  const th = store.get("SELECT * FROM transfer_history WHERE key_name = 'KPTKEYT' ORDER BY id DESC");
  check('a transfer-history row exists', true, !!th);
  check('it names the old panel', KPT_SELLER, th && th.from_name);
  check('it names the new panel', KPT_SELLER2, th && th.to_name);
  check('it names the controller who moved it', CONTROLLER.user, th && th.username);
  check('it records the bills moved', 1, th && th.bills_moved);
  check('it records the pending due moved', price, th && Number(th.pending_moved));
  check('it records the resets carried', 1, th && th.resets_carried);
  check('it records the validity entries carried', 1, th && th.validity_carried);
  const thPage = (await ctrl.get('/transfer_history')).html;
  check('the controller has a Transfer History page', 200, (await ctrl.get('/transfer_history')).status);
  check('the page lists the move', true, thPage.indexOf('KPTKEYT') >= 0 && thPage.indexOf(KPT_SELLER2) >= 0);
  check('a tier below cannot read the transfer history', true,
    (await sell.get('/transfer_history')).status !== 200);

  // The gift move from section 10 went through the same account transfer, so it
  // is in the history too (a gift simply carries no bills).
  check('the gift transfer is logged as well', true,
    store.scalar("SELECT COUNT(*) FROM transfer_history WHERE key_name = 'KPTGIFT1'") >= 1);

  // =============================================================== 13. clean up
  console.log('\n13. cleanup: the KPT branch leaves the database');
  // The Paid click bills the whole chain, so panels ABOVE this branch (the
  // seeded upline) carry KPT key bills too. Reverse those before the branch
  // delete nulls the key ids: give each ancestor its due back and drop the row,
  // restoring the owner's balances exactly.
  const ancestorBills = store.all(
    `SELECT p.* FROM payments p JOIN keys k ON k.id = p.key_id
      WHERE k.key_name LIKE 'KPT%' AND p.kind = 'due'
        AND p.sender_id NOT IN (SELECT id FROM users WHERE username LIKE 'KPT%')`
  );
  for (const b of ancestorBills) {
    if (b.status === 'Pending') store.run('UPDATE users SET due = MAX(due - ?, 0) WHERE id = ?', [Number(b.amount), b.sender_id]);
    store.run('DELETE FROM payments WHERE id = ?', [b.id]);
  }
  // Deleting accounts is the controller's alone (Final Delete Permission Rule),
  // so the branch is removed by the controller login, not by YOGIMASTER.
  await ctrl.post('/delete_user_cascade', { root_id: String(userOf(KPT_ADMIN).id) });
  check('no KPT users left', 0, store.scalar("SELECT COUNT(*) FROM users WHERE username LIKE 'KPT%'"));
  check('no KPT keys left', 0, store.scalar("SELECT COUNT(*) FROM keys WHERE key_name LIKE 'KPT%'"));
  check('no KPT bills left', 0, store.scalar(
    "SELECT COUNT(*) FROM payments WHERE kind = 'due' AND sender_id NOT IN (SELECT id FROM users)"
  ));
  // The validity trail outlives its key by design, so the branch's own history
  // rows are cleared by name — nothing else in that table belongs to this test.
  store.run("DELETE FROM validity_history WHERE key_name LIKE 'KPT%'");
  check('no KPT validity history left', 0, store.scalar(
    "SELECT COUNT(*) FROM validity_history WHERE key_name LIKE 'KPT%'"
  ));
  // The reset and transfer trails also outlive their key by design; clear this
  // branch's own rows by name so nothing of the test is left behind.
  store.run("DELETE FROM key_resets WHERE key_name LIKE 'KPT%'");
  store.run("DELETE FROM transfer_history WHERE key_name LIKE 'KPT%'");
  check('no KPT reset history left', 0, store.scalar(
    "SELECT COUNT(*) FROM key_resets WHERE key_name LIKE 'KPT%'"
  ));
  check('no KPT transfer history left', 0, store.scalar(
    "SELECT COUNT(*) FROM transfer_history WHERE key_name LIKE 'KPT%'"
  ));

  console.log('\n14. the owner data is untouched');
  check('users, keys and transfers exactly as found', true, before === snapshot());

  console.log('\nkey-payment failures: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
