'use strict';
// ---------------------------------------------------------------------------
// Controller Direct Login (impersonation), end to end.
//
// The rules this checks:
//   * only the controller gets a Direct Login button, on every panel list;
//   * one click enters the target's dashboard without that panel's password;
//   * inside the target, every feature/detail renders as that user (the seller
//     gets its generator, a developer does not), and a Back to Controller banner
//     is present on every page;
//   * Back to Controller restores the controller login — no logout, no password;
//   * the target's password_hash is never read or changed;
//   * a tier below the controller cannot start a Direct Login, and the
//     controller cannot target itself.
//
// Like the other suites it runs against the live database, never calls db:reset,
// and never signs in as one of the owner's accounts. It builds its own six-tier
// DL branch (developer -> super master -> master -> admin -> super seller ->
// seller), impersonates each tier, then cascade-deletes the branch. The last
// thing it does is prove the owner's rows — including every password hash — are
// exactly as found.
// ---------------------------------------------------------------------------
const BASE = process.env.GALAXY_BASE || 'http://localhost:3000';
const store = require('../db');
const { ROLES, boldText } = require('../src/config');

const CONTROLLER = { user: 'admin', pass: 'admin123' };
const DL_PASS = 'dl12345';
// One account per tier below the controller, in chain order.
const CHAIN = [
  ['DLDEV', 'developer'],
  ['DLSM', 'super_master_admin'],
  ['DLM', 'master_admin'],
  ['DLA', 'admin'],
  ['DLSS', 'super_seller'],
  ['DLS', 'seller']
];

let failures = 0;
function check(name, want, got) {
  const ok = String(want) === String(got);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got)));
}

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
    async enter(username, password) {
      await send('/login', { method: 'POST', body: { username, password } });
      const home = await send('/home');
      if (home.status !== 200) throw new Error('could not sign in as ' + username + ' (status ' + home.status + ')');
      return home;
    }
  };
}

function userOf(name) {
  return store.get('SELECT * FROM users WHERE username = ?', [name]) || null;
}
// Everything that is not this test's own branch, password hashes included, so a
// Direct Login that secretly rewrote a password would be caught here.
function snapshot() {
  return JSON.stringify(store.all(
    "SELECT id, username, role, due, status, password_hash FROM users WHERE username NOT LIKE 'DL%' ORDER BY id"
  ));
}

(async function main() {
  const before = snapshot();
  const ctrl = jar();
  await ctrl.enter(CONTROLLER.user, CONTROLLER.pass);
  const controllerId = userOf(CONTROLLER.user).id;

  // ---- build a private six-tier branch, each tier creating the one below it
  console.log('\n1. build a six-tier DL branch under the controller');
  let parent = ctrl;
  for (const [name, role] of CHAIN) {
    await parent.post('/add_user', { user_name: name, password: DL_PASS, role });
    const u = userOf(name);
    check(name + ' created as ' + role, role, u && u.role);
    const child = jar();
    await child.enter(name, DL_PASS);
    parent = child;
  }
  check('the seller sits at the bottom', null, ROLES[userOf('DLS').role].next);

  // ===================================== 2. the button is the controller's alone
  console.log('\n2. Direct Login appears on the controller’s lists, and nowhere else');
  const ctrlAll = (await ctrl.get('/all_user')).html;
  check('the controller’s Total Users has the Direct Login form', true, ctrlAll.indexOf('action="/direct_login"') >= 0);
  check('the column header is shown', true, ctrlAll.indexOf(boldText('Direct Login')) >= 0);
  check('a button targets the developer', true,
    ctrlAll.indexOf('name="user_id" value="' + userOf('DLDEV').id + '"') >= 0);
  // Every tier list page shares the view, so each carries the button too.
  for (const route of ['all_developer_panels', 'all_super_master_admins', 'all_master_admins', 'all_admins', 'all_super_sellers', 'all_seller']) {
    check('/' + route + ' offers Direct Login', true, (await ctrl.get('/' + route)).html.indexOf('action="/direct_login"') >= 0);
  }
  // A mid tier sees its own subtree but gets no Direct Login control.
  const adminJar = jar(); await adminJar.enter('DLA', DL_PASS);
  check('an admin’s list has no Direct Login', false, (await adminJar.get('/all_user')).html.indexOf('action="/direct_login"') >= 0);
  const sellerJar = jar(); await sellerJar.enter('DLS', DL_PASS);
  check('a seller cannot even reach a user list with the button', false,
    (await sellerJar.get('/all_key')).html.indexOf('action="/direct_login"') >= 0);

  // ============================ 3. enter each tier, see it as that user, return
  console.log('\n3. one click enters each panel as that user; Back to Controller returns');
  for (const [name, role] of CHAIN) {
    const target = userOf(name);
    const hashBefore = target.password_hash;

    const enter = await ctrl.post('/direct_login', { user_id: String(target.id) });
    check(name + ': Direct Login redirects', 302, enter.status);
    const home = await ctrl.get('/home');
    check(name + ': dashboard opens', 200, home.status);
    check(name + ': shows the target username', true, home.html.indexOf(name) >= 0);
    check(name + ': shows the target role', true, home.html.indexOf(ROLES[role].label) >= 0);
    check(name + ': Back to Controller banner is present', true, home.html.indexOf('action="/back_to_controller"') >= 0);
    check(name + ': no Direct Login button while inside', false, home.html.indexOf('action="/direct_login"') >= 0);

    // Features render as the target: a seller gets its generator, a developer
    // does not; neither gets the controller's delete control.
    const keys = (await ctrl.get('/all_key')).html;
    check(name + ': generator only for a seller', role === 'seller', keys.indexOf('action="/generate_key"') >= 0);
    check(name + ': delete is never the target’s', false, keys.indexOf('action="/delete_key"') >= 0);
    check(name + ': the banner follows onto other pages', true, keys.indexOf('action="/back_to_controller"') >= 0);

    // Return to the controller — same session cookie, no logout, no password.
    const back = await ctrl.post('/back_to_controller', {});
    check(name + ': Back to Controller redirects', 302, back.status);
    const ctrlHome = await ctrl.get('/home');
    check(name + ': back on the controller dashboard', true,
      ctrlHome.html.indexOf(CONTROLLER.user) >= 0 && ctrlHome.html.indexOf(ROLES.controller.label) >= 0);
    check(name + ': the banner is gone', false, ctrlHome.html.indexOf('action="/back_to_controller"') >= 0);
    check(name + ': the password was never touched', hashBefore, userOf(name).password_hash);
  }

  // ===================================================== 4. the security rules
  console.log('\n4. only the controller may start it; no self-target; no bad id');
  // A tier below the controller cannot hop into another account.
  await sellerJar.post('/direct_login', { user_id: String(userOf('DLA').id) });
  check('a seller’s Direct Login is refused', true,
    /Only the controller can use Direct Login/.test((await sellerJar.get('/home')).html));
  // While impersonating, the active role is the target's, so a re-hop is refused.
  await ctrl.post('/direct_login', { user_id: String(userOf('DLS').id) });
  await ctrl.post('/direct_login', { user_id: String(userOf('DLA').id) });
  check('cannot hop again from inside a target', true,
    (await ctrl.get('/home')).html.indexOf('DLS') >= 0);
  await ctrl.post('/back_to_controller', {});

  // The controller cannot target itself, and an unknown id is refused.
  await ctrl.post('/direct_login', { user_id: String(controllerId) });
  check('self-target is refused', true,
    /Pick a panel below the controller/.test((await ctrl.get('/all_user')).html));
  check('still the controller after a self-target', true,
    (await ctrl.get('/home')).html.indexOf(ROLES.controller.label) >= 0);
  await ctrl.post('/direct_login', { user_id: '999999' });
  check('an unknown id is refused', true,
    /not under your panel/.test((await ctrl.get('/all_user')).html));

  // Back to Controller when nothing is active is a safe no-op.
  await ctrl.post('/back_to_controller', {});
  check('Back with no active Direct Login is harmless', 200, (await ctrl.get('/home')).status);
  check('and still the controller', true, (await ctrl.get('/home')).html.indexOf(ROLES.controller.label) >= 0);

  // ====================================== 5. the Final Delete Permission Rule
  console.log('\n5. only the controller may delete; every tier below is refused');
  // The delete control is the controller's alone, on the list and in the handler.
  check('the controller’s list offers Delete', true, ctrlAll.indexOf('delete_user_cascade') >= 0);
  const adminList = (await adminJar.get('/all_user')).html;
  check('an admin’s list offers no Delete', false, adminList.indexOf('delete_user_cascade') >= 0);
  // A hand-made cascade delete from a non-controller is refused and changes nothing.
  const ssBefore = JSON.stringify(store.all('SELECT id, username FROM users ORDER BY id'));
  await adminJar.post('/delete_user_cascade', { root_id: String(userOf('DLSS').id) });
  check('an admin’s hand-made delete is refused', true, !!userOf('DLSS'));
  check('and is told only the controller may', true,
    /Only the controller can delete accounts/.test((await adminJar.get('/all_user')).html));
  check('no user row moved', true, ssBefore === JSON.stringify(store.all('SELECT id, username FROM users ORDER BY id')));

  // =============================================================== 6. clean up
  console.log('\n6. cleanup: the DL branch leaves the database');
  await ctrl.post('/delete_user_cascade', { root_id: String(userOf('DLDEV').id) });
  check('no DL users left', 0, store.scalar("SELECT COUNT(*) FROM users WHERE username LIKE 'DL%'"));

  console.log('\n7. the owner data (and every password) is untouched');
  check('owner rows exactly as found', true, before === snapshot());

  console.log('\ndirect-login failures: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});