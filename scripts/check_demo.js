'use strict';
// ---------------------------------------------------------------------------
// Demo-key checks: the sidebar "Allow demo key" switch plus its days box, and
// the login page's public demo, which is the only place a demo key is started.
// /all_key has no demo control at all — the seller's generator makes normal keys.
//
//   node scripts/check_demo.js
//
// Everything goes through the HTTP surface a browser uses, including the
// duplicated allow_demo field the reference markup posts (hidden 0 + checkbox 1),
// which is the shape that used to break the switch.
// ---------------------------------------------------------------------------
// This suite writes and deletes keys, so it must never run against the owner's
// working database. npm run check points GALAXY_DB at a throwaway copy.
if (!process.env.GALAXY_DB) {
  console.error('Refusing to run against the live database. Use: npm run check');
  process.exit(1);
}
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('../db');
const panelKeys = require('../src/queries/keys');
const { boldText } = require('../src/config');

const T = process.env.TEMP || '/tmp';
const B = process.env.GALAXY_BASE || 'http://localhost:3000';
let fails = 0;
const created = [];

function check(name, expected, actual) {
  const ok = String(expected) === String(actual);
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  expected=${expected} actual=${actual}`);
}

function login(user, pass) {
  const jar = path.join(T, `demo_j_${user}.txt`);
  execFileSync('curl', ['-s', '-c', jar, '-o', path.join(T, `demo_l_${user}.html`),
    '-X', 'POST', '-d', `username=${user}&password=${pass}`, B + '/login']);
  return jar;
}

function get(jar, url) {
  const file = path.join(T, 'demo_page.html');
  execFileSync('curl', ['-s', '-b', jar, '-L', '-o', file, B + url]);
  return fs.readFileSync(file, 'utf8');
}

function post(jar, url, body) {
  const file = path.join(T, 'demo_post.html');
  const args = ['-s', '-o', file];
  if (jar) args.push('-b', jar);
  args.push('-X', 'POST', '--data', body.join('&'), B + url);
  execFileSync('curl', args);
  return fs.readFileSync(file, 'utf8');
}

// Exactly what the browser sends: the hidden 0 always, plus the checkbox's 1
// when it is on, plus the days box. Turning the switch on without a usable
// number is refused, so the helper carries the length that is already stored.
const setDemo = (jar, on, days) => post(jar, '/toggle_demo',
  [on ? 'allow_demo=0&allow_demo=1' : 'allow_demo=0', 'days=' + (days === undefined ? demoDaysSet() : days)]);
const demoState = () => store.scalar("SELECT value FROM settings WHERE key = 'allow_demo'");
const keyCount = () => store.scalar('SELECT COUNT(*) FROM keys');
const newest = () => store.all('SELECT * FROM keys ORDER BY id DESC LIMIT 1')[0];

function switchRendered(jar) {
  const html = get(jar, '/home');
  const at = html.indexOf('id="allow_demo_switch"');
  return /checked/.test(html.slice(at - 200, at + 200));
}

// True when a page still carries a control that can *start* a demo key — a
// generator field named type, a Start Demo button, or a form posting type=demo.
// /all_key must never have one: the sidebar switch is the only controller
// control and the login page is the only place a demo is started. The delete
// target legitimately offers value="demo" for wiping demos, and the sidebar
// posts allow_demo + days to /toggle_demo, so neither counts as a starter.
function demoControl(jar) {
  const html = get(jar, '/all_key');
  return /name="type"/.test(html) ||
    /Start Demo/.test(html) ||
    /type=demo/.test(html);
}

const admin = login('admin', 'admin123');
const sell = login('YOGISELL', 'demo123');
const controllerId = store.scalar("SELECT id FROM users WHERE role = 'controller'");
const sellerId = store.scalar("SELECT id FROM users WHERE username = 'YOGISELL'");
const demoDaysSet = () => store.scalar("SELECT value FROM settings WHERE key = 'demo_days'");
// Everything below compares against whatever the seed left, because the only
// thing that rewrites `demo_days` is the sidebar days box — section 7.
const baselineDays = demoDaysSet();
// A seller's normal keys always run for the controller's seller-key validity;
// the days a hand-made /generate_key post asks for are ignored.
const sellerDays = Number(store.scalar("SELECT value FROM settings WHERE key = 'panel_days'")) || 30;

// Numbered demos are handed out by the website, so the seed never makes one and
// anything sitting here is residue from an interrupted run. Clearing it keeps
// "the first click gives DEMO01" true on every run.
const DEMO_ROWS = "key_name LIKE 'DEMO%' AND substr(key_name, 5) GLOB '[0-9]*'";
const demoNo = (name) => parseInt(String(name).slice(4), 10);
const highestDemo = () => store.scalar(
  `SELECT COALESCE(MAX(CAST(substr(key_name, 5) AS INTEGER)), 0) FROM keys WHERE ${DEMO_ROWS}`);
store.run(`DELETE FROM keys WHERE ${DEMO_ROWS}`);
// The panel's starting inventory. This suite runs against the live database,
// which holds the owner's own keys as well as the seeded ones, so the cleanup
// below promises the count it found rather than a number copied from db/seed.js.
const baselineKeys = keyCount();
const baselineDemo = store.scalar("SELECT COUNT(*) FROM keys WHERE type = 'demo'");

console.log('\n=== 1. the sidebar switch');
setDemo(admin, true);
check('allow_demo after switching ON', '1', demoState());
check('switch renders checked', true, switchRendered(admin));
setDemo(admin, false);
check('allow_demo after switching OFF', '0', demoState());
check('switch renders unchecked', false, switchRendered(admin));
setDemo(admin, true);
check('allow_demo after switching ON again', '1', demoState());
check('and it renders checked', true, switchRendered(admin));

console.log('\n=== 2. /generate_key makes normal keys only');
check('the controller page carries no demo control', false, demoControl(admin));
check('nor does a tier page', false, demoControl(sell));
const daysBefore = demoDaysSet();

// Making a key is the seller's job now, so the controller posting the
// generator by hand is refused like any other panel above the seller.
const n1 = keyCount();
post(admin, '/generate_key', ['type=demo', 'for_id=' + controllerId, 'days=5']);
check('the controller’s generate is refused', n1, keyCount());

// The seller's card has no Type field, and a hand-posted type=demo is ignored:
// what comes out is a normal key at the seller level, running for the
// controller's seller-key validity rather than the posted 5 days.
post(sell, '/generate_key', ['type=demo', 'for_id=' + sellerId, 'days=5']);
check('one key created', n1 + 1, keyCount());
const made = newest();
created.push(made.id);
check('the demo request comes back normal', 'normal', made.type);
check('days are the controller’s validity, not the posted 5', sellerDays, made.days);
check('status', 'active', made.status);
check('nothing is marked paid', 0, made.has_paid);
check('owned by the seller', sellerId, made.created_by_id);
check('sits on the seller level', sellerId, made.seller_id);
check('visible in the controller /all_key', true, get(admin, '/all_key').includes(made.key_name));
check('and in the seller’s own /all_key', true, get(sell, '/all_key').includes(made.key_name));
check('it never hands out a DEMO name', 0, highestDemo());
check('and never rewrites the site demo length', String(daysBefore), demoDaysSet());

console.log('\n=== 3. a tier cannot start a demo either');
const n2 = keyCount();
post(sell, '/generate_key', ['type=demo', 'for_id=' + sellerId, 'days=3']);
check('no demo invented', n2 + 1, keyCount());
check('the seller gets a normal key', 'normal', newest().type);
check('under its own account', sellerId, newest().created_by_id);
created.push(newest().id);
post(sell, '/generate_key', ['type=normal', 'days=7']);
check('the seller still makes its own normal key', n2 + 2, keyCount());
check('and that key is normal too', 'normal', newest().type);
created.push(newest().id);
check('the DEMO counter never moved', 0, highestDemo());

console.log('\n=== 4. the switch gates the one demo entrance');
setDemo(admin, false);
const demoNoBefore = highestDemo();
const n2b = keyCount();
const refused = JSON.parse(post(null, '/create_demo_key', ['client_name=demo_user']));
check('the login button refuses', false, !!refused.ok);
check('and issues no key at all', n2b, keyCount());
check('the DEMO counter does not move', demoNoBefore, highestDemo());
check('the button is not even rendered while off', false,
  execFileSync('curl', ['-s', B + '/login'], { encoding: 'utf8' }).includes('id="openDemoModal"'));
const n3 = keyCount();
post(sell, '/generate_key', ['type=demo', 'for_id=' + sellerId, 'days=4']);
check('the generator still only makes normal keys', 'normal', newest().type);
check('one normal key, no demo', n3 + 1, keyCount());
created.push(newest().id);

console.log('\n=== 5. every public click gets the next DEMO number');
setDemo(admin, true);
const loginPage = execFileSync('curl', ['-s', B + '/login'], { encoding: 'utf8' });
check('the demo button is the whole request', true, /id="openDemoModal"/.test(loginPage));
check('no days field to fill', false, /id="demoDaysInput"/.test(loginPage));
check('no second Create Key button', false, /id="generateBtn"/.test(loginPage));
check('its label advertises the setting (' + baselineDays + ' days now)', true,
  loginPage.includes(boldText('Generate ' + baselineDays + '-Day Demo Key')));

function publicDemo(extraField) {
  return JSON.parse(post(null, '/create_demo_key', ['client_name=demo_user'].concat(extraField || [])));
}
const rowOf = (name) => store.get('SELECT * FROM keys WHERE key_name = ?', [name]);
const pad = (n) => 'DEMO' + String(n).padStart(2, '0');

const first = publicDemo([]);
check('click succeeds while demo is on', true, !!first.ok);
check('on a clean panel the first key is DEMO01', 'DEMO01', first.key);
const row1 = rowOf(first.key);
created.push(row1.id);
check('type', 'demo', row1.type);
check('controller level as well', controllerId, row1.created_by_id);
check('length is the controller choice, not the visitor\'s', baselineDays, row1.days);
check('expiry about ' + baselineDays + ' days out', true,
  store.scalar(`SELECT (julianday(expire_date) - julianday('now','localtime')) BETWEEN ? AND ?
                FROM keys WHERE id = ?`, [baselineDays - 0.15, baselineDays + 0.15, row1.id]) === 1);

const second = publicDemo([]);
check('the next click goes up to DEMO02', 'DEMO02', second.key);
check('as its own row', true, rowOf(second.key).id !== row1.id);
check('and the earlier key is left alone', String(row1.start_date), String(rowOf('DEMO01').start_date));

// The counter only ever climbs, whatever the browser tries to post.
let lastNo = demoNo(second.key);
const n5 = keyCount();
['days=7', 'days=1', 'days=abc', 'days=0', 'days=99999', ''].forEach(function (field) {
  const click = publicDemo(field ? [field] : []);
  created.push(rowOf(click.key).id);
  lastNo++;
  check('click ' + (field || '(no field)') + ' issues ' + pad(lastNo), pad(lastNo), click.key);
  check('  with the controller\'s ' + baselineDays + ' days', baselineDays, rowOf(click.key).days);
});
check('six clicks, six rows', n5 + 6, keyCount());
check('and the counter sits at ' + lastNo, lastNo, highestDemo());

// Deleting an old demo does not make a new click reuse its name.
store.run('DELETE FROM keys WHERE key_name = ?', ['DEMO01']);
const afterDelete = publicDemo([]);
created.push(rowOf(afterDelete.key).id);
check('a deleted name is not handed out twice', true, afterDelete.key !== 'DEMO01');
check('the click simply went up to ' + pad(lastNo + 1), pad(lastNo + 1), afterDelete.key);

console.log('\n=== 6. the sidebar decides what the website offers');
check('setting starts back at the seeded ' + baselineDays, String(baselineDays), demoDaysSet());

post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=6']);
check('the controller asked for 6 in the days box', '6', demoDaysSet());

const sitePage = execFileSync('curl', ['-s', B + '/login'], { encoding: 'utf8' });
check('login label now advertises 6 days', true,
  sitePage.includes(boldText('Generate 6-Day Demo Key')));

const d6 = publicDemo([]);
created.push(rowOf(d6.key).id);
check('the click hands out the controller\'s 6', 6, rowOf(d6.key).days);
check('on the next number up', true, /^DEMO\d{2,}$/.test(d6.key));
check('expiry about six days out', true,
  store.scalar(`SELECT (julianday(expire_date) - julianday('now','localtime')) BETWEEN 5.9 AND 6.1
                FROM keys WHERE key_name = ?`, [d6.key]) === 1);

// Hand the length back the same way the controller would — the sidebar box.
post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=' + baselineDays]);
check('back to the seeded ' + baselineDays + ' days', String(baselineDays), demoDaysSet());

console.log('\n=== 7. the sidebar asks the days before it turns on');
// One form holds the switch and the length box. The switch cannot go up without
// a usable number in the box — the browser asks, and the server refuses the same
// way, so the question cannot be skipped by posting the form by hand.
const homeHtml = () => get(admin, '/home');
const sidebarDays = () => {
  const html = homeHtml();
  const at = html.indexOf('id="demo_days_input"');
  if (at < 0) return 'missing';
  const m = /value="(\d+)"/.exec(html.slice(at, at + 300));
  return m ? m[1] : 'no value';
};
const row = homeHtml();
check('the row carries a labelled days box', true,
  /class="demo-days-box"/.test(row) && /Demo days/.test(row));
check('the box renders the stored length', String(baselineDays), sidebarDays(admin));
check('and a save button next to it', true, /demo-days-save/.test(row));
check('the switch markup keeps the reference duplicate field', true,
  /name="allow_demo" value="0"[\s\S]*name="allow_demo" value="1"/.test(row));

// Start from a switched-off panel, because that is the state the question is
// asked in: flip it up and it wants a number before it lets you.
post(admin, '/toggle_demo', ['allow_demo=0', 'days=' + baselineDays]);
check('demo starts this section off', '0', demoState());

post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1']);
check('no number, no switch on', '0', demoState());
check('the page says why', true, homeHtml().includes('Choose the demo days first'));
post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=abc']);
check('nonsense number keeps it off', '0', demoState());
post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=0']);
check('zero keeps it off', '0', demoState());
post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=99999']);
check('out of range keeps it off', '0', demoState());
check('and none of that touched the stored length', String(baselineDays), demoDaysSet());

post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=9']);
check('the number typed in the box turns it on', '1', demoState());
check('and saves that number', '9', demoDaysSet());
check('the box re-renders with 9', '9', sidebarDays(admin));
check('the login page followed to 9 days', true,
  execFileSync('curl', ['-s', B + '/login'], { encoding: 'utf8' })
    .includes(boldText('Generate 9-Day Demo Key')));

post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=abc']);
check('while on, a bad number leaves the length', '9', demoDaysSet());
check('and leaves demo enabled', '1', demoState());
check('the page asks for a real number instead', true,
  (post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=0']),
   homeHtml().includes('type a number between 1 and 3650')));

post(admin, '/toggle_demo', ['allow_demo=0', 'days=3']);
check('switching off still saves the number', '3', demoDaysSet());
check('and turns demo off', '0', demoState());
post(admin, '/toggle_demo', ['allow_demo=0']);
check('switching off needs no number at all', '3', demoDaysSet());
check('and stays off', '0', demoState());

// Hand the length back the same way the controller would.
post(admin, '/toggle_demo', ['allow_demo=0&allow_demo=1', 'days=' + baselineDays]);
check('restored to the seeded ' + baselineDays + ' days', String(baselineDays), demoDaysSet());
check('rendered in the sidebar', String(baselineDays), sidebarDays(admin));

console.log('\n=== 8. the Demo Keys delete target');
// The website keeps handing out DEMO01, DEMO02 ... on its own, so the mass
// delete needs one target that wipes the whole stack — and it has to obey the
// same two rules as every other target: password first, subtree only.
setDemo(admin, true);
const demoRowCount = () => store.scalar(`SELECT COUNT(*) FROM keys WHERE ${DEMO_ROWS}`);
const demoTypeCount = () => store.scalar("SELECT COUNT(*) FROM keys WHERE type = 'demo'");
// The panel already holds demo keys by the time this section runs — the numbered
// ones from sections 5-6 plus the seeded one db/seed.js makes — so everything
// here counts from what is there instead of assuming a clean slate.
const numberedBefore = demoRowCount();
const seededDemo = demoTypeCount() > numberedBefore;
[1, 2, 3].forEach(function () { created.push(rowOf(publicDemo([]).key).id); });
check('three more demos sit in the list', numberedBefore + 3, demoRowCount());
const delSelect = () => (get(admin, '/all_key').match(/<select name="delete_type"[\s\S]*?<\/select>/) || [''])[0];
check('the delete select offers them as its own target', true,
  delSelect().includes('value="demo">' + boldText('Demo Keys') + '</option>'));
const n8 = keyCount();
const demoType = demoTypeCount();
check('the target covers the seeded demo too', demoType, numberedBefore + 3 + (seededDemo ? 1 : 0));
// The gate is the fixed word LOVE, not anybody's login password, and the check
// is case- and space-tolerant. Curl encodes a leading space as %20 and a
// trailing one as +, so the padded attempt really does send " LOVE ".
const delPass = (word) => post(admin, '/all_key',
  ['mass_delete_submit=1', 'delete_type=demo', 'admin_pass=' + word]);
delPass('notmine');
check('a wrong word deletes nothing', n8, keyCount());
check('and every demo is still there', demoType, demoTypeCount());
check('the page says why', true, get(admin, '/all_key').includes('password did not match'));
delPass('admin123');
check('the login password no longer opens it', demoType, demoTypeCount());
check('and the page refuses that too', true, get(admin, '/all_key').includes('password did not match'));
delPass('%20LOVE+');
check('the word, padded with spaces, works', 0, demoTypeCount());
check('normal keys were left alone', n8 - demoType, keyCount());
check('the page counts them out', true,
  get(admin, '/all_key').includes(demoType + ' demo key(s) deleted'));
[1, 2, 3].forEach(function () { created.push(rowOf(publicDemo([]).key).id); });
delPass('love');
check('and the same word in lower case works again', 0, demoTypeCount());
const restarted = publicDemo([]);
created.push(rowOf(restarted.key).id);
check('the counter still starts over', 'DEMO01', restarted.key);

// A tier cannot reach the controller's demos: the delete is subtree-scoped,
// even with the right word.
const n8b = keyCount();
post(sell, '/all_key', ['mass_delete_submit=1', 'delete_type=demo', 'admin_pass=LOVE']);
check('a tier delete finds nothing of its own', n8b, keyCount());
check('and the demo the website just made survives', 1, demoRowCount());

console.log('\n=== 9. the other delete targets are untouched');
const options = delSelect();
check('the select carries exactly six options', 6, (options.match(/<option/g) || []).length);
check('placeholder first', true, options.includes('<option value="">'));
check('and the five targets in order', 'expired,deactive,unpaid,mac_unregistered,demo',
  (options.match(/value="([a-z_]+)"/g) || []).map(function (m) { return m.slice(7, -1); }).join(','));
post(admin, '/all_key', ['mass_delete_submit=1', 'delete_type=', 'admin_pass=LOVE']);
check('no target chosen deletes nothing', n8b, keyCount());
check('and the page asks for one', true, get(admin, '/all_key').includes('Choose a delete target first'));

// Numbered demos and the keys this script started are both test data, so the
// panel goes back to the inventory it was found with.
for (const id of created) store.run('DELETE FROM keys WHERE id = ?', [id]);
store.run(`DELETE FROM keys WHERE ${DEMO_ROWS}`);
// The Demo Keys target really does wipe the seeded demo key as well, so hand
// back as many demo keys as the panel started with, made the way db/seed.js
// makes them, before asserting a clean panel.
let restoreAttempts = baselineDemo;
while (store.scalar("SELECT COUNT(*) FROM keys WHERE type = 'demo'") < baselineDemo && restoreAttempts-- > 0) {
  panelKeys.generate({ owner: { id: controllerId }, days: Number(baselineDays),
    type: 'demo', hasPaid: 1, mac: '' });
}
setDemo(admin, true);
check('cleanup leaves the ' + baselineKeys + ' keys it started with', baselineKeys, keyCount());
check('and no DEMO rows behind', 0, highestDemo());
console.log('\ndemo failures: ' + fails);
process.exit(fails ? 1 : 0);
