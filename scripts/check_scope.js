'use strict';
// Plan step 7: prove the single access-control rule - every list page is
// filtered by the requester's subtree. Compares the DB's expected rows with the
// rows actually rendered in the pages scripts/smoke_tiers.sh just fetched.
const fs = require('fs');
const path = require('path');
const store = require('../db');
const { subtreeIds } = require('../src/queries/tree');
const { PANEL_LIST_ROUTE, ROLE_ORDER } = require('../src/config');

const T = process.env.TEMP || process.env.TMP || '/tmp';

// The menu shows exactly one list page per tier below the requester, in
// ROLE_ORDER. The same rule is expressed two ways here: what the config says a
// role should offer, and what the rendered sidebar really lists, in the order
// the links appear on the page.
const menuRoutesFor = role =>
  ROLE_ORDER.slice(ROLE_ORDER.indexOf(role) + 1)
    .filter(r => PANEL_LIST_ROUTE[r])
    .map(r => '/' + PANEL_LIST_ROUTE[r]);

function renderedMenuRoutes(html) {
  return Object.values(PANEL_LIST_ROUTE)
    .map(route => ({ route, at: html.indexOf('href="/' + route + '"') }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(x => '/' + x.route);
}

// The two owner accounts that used to sit at admin and super_seller have
// passwords this suite may not use, so those tiers are covered by the throwaway
// panels smoke_tiers.sh builds under YOGIMASTER and deletes again afterwards.
const TIERS = [
  ['admin', 'controller'],
  ['LUCKYDEV', 'developer'],
  ['LUCKYSUPERMASTER', 'super_master_admin'],
  ['YOGIMASTER', 'master_admin'],
  ['TPADM', 'admin'],
  ['TPSUP', 'super_seller'],
  ['YOGISELL', 'seller']
];

function page(who, name) {
  const f = path.join(T, 'page_' + who + '_' + name + '.html');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

// Everything inside <tbody> ... </tbody>, per table on the page.
function bodyRows(html) {
  const out = [];
  const re = /<tbody>([\s\S]*?)<\/tbody>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    for (const tr of body.split(/<\/tr>/)) {
      if (/<td/.test(tr)) out.push(tr);
    }
  }
  return out;
}

// A real data row has several plain cells; the empty state is one colspan row.
function realRowCount(html) {
  return bodyRows(html).filter(r => (r.match(/<td/g) || []).length >= 2 && !/colspan/.test(r)).length;
}

// Cell-level lookup inside the tables only, so the sidebar/topbar (which
// legitimately repeat names) cannot be mistaken for a leaked row. Only the
// leading identity cells count: "Created By" names a parent, which is fine.
function identityCells(html, columns = 1) {
  const out = [];
  for (const row of bodyRows(html)) {
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
    for (let i = 0; i < Math.min(columns, cells.length); i++) {
      out.push(cells[i].replace(/<[^>]+>/g, '').trim());
    }
  }
  return out;
}

let failures = 0;
function check(label, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + '  expected=' + expected + ' actual=' + actual);
}

for (const [who, role] of TIERS) {
  const me = store.get('SELECT * FROM users WHERE username = ?', [who]);
  // smoke_tiers.sh writes no fixtures for an account it could not sign in as,
  // and comparing an absent page with the database would only be measuring that
  // missing login.
  if (!me || !fs.existsSync(path.join(T, 'page_' + who + '_home.html'))) {
    console.log('\n' + who + ' (' + role + ') — skipped, nothing was fetched for it');
    continue;
  }
  const ids = subtreeIds(me.id);
  const clause = ids.join(',');

  const dbUsers = store.all(`SELECT username, role FROM users WHERE id IN (${clause})`);
  const keyCount = store.scalar(`SELECT COUNT(*) FROM keys k WHERE k.created_by_id IN (${clause})`);
  const txCount = store.scalar(`SELECT COUNT(*) FROM payments p WHERE p.sender_id IN (${clause}) OR p.receiver_id IN (${clause})`);

  console.log('\n' + who + ' (' + role + ')  subtree=' + ids.length + ' user(s)');

  // --- /all_user: every descendant, and nobody else. The controller is the
  //     highest authority, not a managed panel, so its own row is not listed.
  const au = page(who, 'all_user');
  check('/all_user rows', dbUsers.filter(u => u.role !== 'controller').length, realRowCount(au));
  const seenUsers = identityCells(au, 1);
  const outside = new Set(store.all(`SELECT username FROM users WHERE id NOT IN (${clause})`).map(u => u.username));
  const leakUsers = seenUsers.filter(u => outside.has(u));
  check('/all_user leaks outside subtree', 0, leakUsers.length);
  if (leakUsers.length) console.log('        leaked: ' + leakUsers.join(', '));
  // Final Delete Permission Rule: the account-delete control is the controller's
  // alone, on every list. It renders once per non-controller row, so it appears
  // for the controller (whose subtree always holds panels below it) and for no
  // other tier.
  const hasDeletable = role === 'controller' && dbUsers.some(u => u.role !== 'controller');
  check('/all_user delete form only for controller', hasDeletable,
    au.indexOf('action="/delete_user_cascade"') >= 0);

  // --- per-tier list pages
  for (const [r, route] of Object.entries(PANEL_LIST_ROUTE)) {
    const expected = dbUsers.filter(u => u.role === r).length;
    const html = page(who, route);
    if (!html) { console.log('  --    /' + route + ' not in this sidebar'); continue; }
    check('/' + route + ' rows', expected, realRowCount(html));
  }

  // --- /all_key: only keys created inside the subtree. The key cell may carry
  //     a client name on a second line, so only its first line identifies the key.
  const ak = page(who, 'all_key');
  // The controller's per-key Validity History modals carry their own tables
  // after the main one; only the first tbody is the Total Keys table itself.
  const akTable = ak.slice(0, ak.indexOf('</tbody>') + '</tbody>'.length);
  check('/all_key rows', keyCount, realRowCount(akTable));
  const seenKeys = new Set(identityCells(akTable, 1).map(t => t.split('\n')[0].trim()));
  const outsideKeys = store.all(`SELECT key_name FROM keys WHERE created_by_id NOT IN (${clause})`)
    .filter(k => seenKeys.has(k.key_name)).map(k => k.key_name);
  check('/all_key leaks outside subtree', 0, outsideKeys.length);
  if (outsideKeys.length) console.log('        leaked: ' + outsideKeys.join(', '));

  // --- key lifecycle is split by role: a seller alone carries the generator,
  //     and the controller alone carries delete and extend. A control that is
  //     rendered for the wrong tier is as much a leak as a row that is.
  check('/all_key generator only for seller', role === 'seller',
    ak.indexOf('action="/generate_key"') >= 0);
  check('/all_key delete only for controller', role === 'controller',
    ak.indexOf('action="/delete_key"') >= 0);
  check('/all_key extend only for controller', role === 'controller',
    ak.indexOf('action="/extend_id"') >= 0);
  // Edit Validity (exact days, up or down) and its history are the controller's
  // alone too; the form only renders when the subtree holds at least one key.
  if (role === 'controller' || keyCount > 0) {
    check('/all_key edit validity only for controller', role === 'controller',
      ak.indexOf('action="/edit_validity"') >= 0);
    // The one-click full hierarchy is the controller's alone as well.
    check('/all_key hierarchy only for controller', role === 'controller',
      ak.indexOf('id="modal-hierarchy') >= 0);
    // Complete Key Transfer (whole account) is the controller's alone, on
    // ordinary rows. Gift rows carry their own transfer control instead.
    check('/all_key transfer only for controller', role === 'controller',
      ak.indexOf('action="/transfer_key"') >= 0);
  }
  // The seller-key validity control is the controller's alone; every other tier
  // only reads the number in its generator.
  check('/all_key seller-validity only for controller', role === 'controller',
    ak.indexOf('action="/set_seller_days"') >= 0);
  // Gift keys are created and transferred by the controller alone.
  check('/all_key gift create only for controller', role === 'controller',
    ak.indexOf('action="/create_gift_key"') >= 0);
  // The trash control is not rendered at all for the tiers below the controller
  // — not even disabled. The controller's Global Utilities toolbar carries one.
  check('/all_key trash control only for controller', role === 'controller',
    ak.indexOf('fa-trash') >= 0);
  // Correcting a client name is every tier's option; the key name is nobody's.
  if (keyCount > 0) {
    check('/all_key offers the client-name editor', true,
      ak.indexOf('action="/update_client_name"') >= 0);
  }
  check('/all_key cannot rename a key', false, ak.indexOf('action="/update_name"') >= 0);

  // --- every panel prints the device MAC ID beside the key, registered or not.
  check('/all_key prints the Mac ID column', true, ak.indexOf('<th>Mac ID</th>') >= 0);

  // --- the five tiers above the seller share one dropdown-chosen column; the
  //     Seller column stays. A seller's dropdown offers only the super seller
  //     above it, so the higher names stay out of its table entirely.
  const CHAIN_LABELS = ['Developer', 'Super Master Admin', 'Master Admin', 'Admin', 'Super Seller', 'Seller'];
  const PICK_LABELS = ['Developer', 'Super Master', 'Master', 'Admin', 'Super Seller'];
  const pickAt = ak.indexOf('id="chainPick"');
  const pickBlock = pickAt >= 0 ? ak.slice(pickAt, ak.indexOf('</select>', pickAt)) : '';
  const options = PICK_LABELS.filter(l => pickBlock.indexOf('>' + l + '</option>') >= 0);
  const shown = CHAIN_LABELS.filter(l => ak.indexOf('<th>' + l + '</th>') >= 0);
  if (role === 'seller') {
    check('/all_key seller dropdown offers super seller only', 'Super Seller', options.join(','));
    check('/all_key seller sees super seller + seller', 'Super Seller,Seller', shown.join(','));
  } else {
    check('/all_key dropdown carries the five tiers', PICK_LABELS.join(','), options.join(','));
    check('/all_key one chosen tier column + seller', 'Developer,Seller', shown.join(','));
  }

  // --- /transaction: settled money that touched the subtree. A row may name a
  //     parent above the requester (the reference shows both sides), so the rule
  //     is that at least one of sender/receiver belongs to the subtree.
  const tx = page(who, 'transaction');
  check('/transaction rows', txCount, realRowCount(tx));
  const inTree = new Set(dbUsers.map(u => u.username));
  const txRows = bodyRows(tx).filter(r => !/colspan/.test(r));
  const badTx = txRows.filter(r => {
    const cells = identityCells('<tbody>' + r + '</tbody>', 2);
    return !cells.some(c => inTree.has(c));
  }).length;
  check('/transaction rows not touching subtree', 0, badTx);

  // --- dashboard tiles must agree with the same subtree
  const home = page(who, 'home');
  const tileTotal = Number((/Total Keys[\s\S]{0,400}?<div[^>]*>\s*(\d+)\s*<\/div>/.exec(home) || [])[1] || -1);
  check('/home Total Keys tile', keyCount, tileTotal);

  // --- sidebar: one list link per tier below the requester, in chain order.
  // This is the check that proves a new tier is actually reachable from the
  // menu and not only present in the database.
  check('/home sidebar list links', menuRoutesFor(role).join(','), renderedMenuRoutes(home).join(','));
}

console.log('\nscope failures: ' + failures);
process.exit(failures ? 1 : 0);
