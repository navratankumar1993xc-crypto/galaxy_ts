'use strict';
const store = require('../../db');
const users = require('../../src/queries/users');
const { ROLES, PANEL_LIST_ROUTE, boldText } = require('../../src/config');
const { subtreeIds } = require('../../src/queries/tree');

// One entry per list page, matching the reference headings and card chrome.
const LIST_PAGES = {
  all_user:                { role: null,                 heading: 'All Users',              headKind: 'title' },
  all_developer_panels:    { role: 'developer',          heading: 'All Developer Panels',   headKind: 'h3back' },
  all_super_master_admins: { role: 'super_master_admin', heading: 'All Super Master Admins', headKind: 'h3' },
  all_master_admins:       { role: 'master_admin',       heading: 'All Master Admins',      headKind: 'icon' },
  all_admins:              { role: 'admin',              heading: 'All Admins',             headKind: 'icon' },
  all_super_sellers:       { role: 'super_seller',       heading: 'All Super Sellers',      headKind: 'icon' },
  all_seller:              { role: 'seller',             heading: 'All Sellers',            headKind: 'icon' }
};

function back(req) {
  return req.get('referer') || '/home';
}

function owns(me, id) {
  return subtreeIds(me.id).includes(Number(id));
}

// ---------------------------------------------------------------- add panel
function addForm(req, res) {
  const next = ROLES[res.locals.me.role].next;
  if (!next) {
    req.session.flash = [{ type: 'warning', text: 'This panel has no child tier to create.' }];
    return res.redirect('/home');
  }
  res.render('tiers/add_user', {
    nextRole: next,
    nextRoleLabel: ROLES[next].label,
    // Matches the reference, which loads the validation plugin on this page.
    validation: true
  });
}

function addSubmit(req, res) {
  const me = res.locals.me;
  const next = ROLES[me.role].next;
  const username = String(req.body.user_name || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role;

  if (!username || !password) {
    req.session.flash = [{ type: 'danger', text: 'User name and password are both required.' }];
    return res.redirect('/add_user');
  }
  if (!next || role !== next) {
    req.session.flash = [{ type: 'danger', text: 'You can only create ' + (next ? ROLES[next].label : 'no') + ' panels.' }];
    return res.redirect('/add_user');
  }
  if (store.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username])) {
    req.session.flash = [{ type: 'danger', text: 'User name ' + username + ' already exists.' }];
    return res.redirect('/add_user');
  }

  users.create({
    username, password, role, parentId: me.id, createdBy: me.username
  });

  req.session.flash = [{
    type: 'success',
    text: ROLES[role].label + ' panel ' + username + ' created.'
  }];
  res.redirect('/' + PANEL_LIST_ROUTE[role]);
}

// ---------------------------------------------------------------- list pages
function list(route) {
  const cfg = LIST_PAGES[route];
  return function (req, res) {
    const me = res.locals.me;
    // The controller is the highest authority, not a managed panel, so its own
    // row never appears in the users lists — the table lists the panels below
    // it. (Per-tier pages already exclude it by role; this also drops it from
    // the controller's own "Total Users" view.)
    const rows = (cfg.role
      ? users.listByRole(me.id, cfg.role)
      : users.listAllInSubtree(me.id)
    ).filter(function (u) { return u.role !== 'controller'; });

    // Created By names the creating authority, not a login string: panels made
    // by the top login read "Controller" (its title), while panels made by any
    // tier below keep their creator's panel name.
    rows.forEach(function (u) {
      const name = u.parent_name || u.created_by;
      const creator = users.getByUsername(name);
      u.createdByLabel = creator && creator.role === 'controller' ? ROLES.controller.label : name;
    });

    res.render('tiers/user_list', {
      heading: boldText(cfg.heading),
      headKind: cfg.headKind,
      rows,
      // Final Delete Permission Rule: only the controller may delete anything.
      // It gets the Delete control on every list (full permission over any
      // account below it); every other tier gets none, on any page.
      showDelete: me.role === 'controller',
      // Direct Login is the controller's alone: it steps into any panel below it
      // without that panel's password. While impersonating, the active role is
      // the target's (not controller), so the button disappears on its own.
      showDirectLogin: me.role === 'controller'
    });
  };
}

// ---------------------------------------------------------------- status
// GET toggles a panel open/closed; POST resets a password. The reference uses
// one endpoint for both, and the markup shows it.
function statusUpdate(req, res) {
  const me = res.locals.me;

  if (req.method === 'POST') {
    const id = Number(req.body.id);
    const password = String(req.body.password || '');
    if (!owns(me, id) || !password) {
      req.session.flash = [{ type: 'danger', text: 'Password was not reset.' }];
      return res.redirect(back(req));
    }
    users.setPassword(id, password);
    req.session.flash = [{ type: 'success', text: 'Password updated for ' + users.getById(id).username + '.' }];
    return res.redirect(back(req));
  }

  const id = Number(req.query.u_id);
  if (!owns(me, id)) {
    req.session.flash = [{ type: 'danger', text: 'That account is not under your panel.' }];
    return res.redirect(back(req));
  }
  const user = users.getById(id);
  // Final Rule: the controller is the highest authority of the whole software.
  // No login may inactive, disable or block it — and it cannot close itself.
  if (user.role === 'controller') {
    req.session.flash = [{ type: 'danger', text: 'The controller is the highest authority — it can never be closed, disabled or blocked.' }];
    return res.redirect(back(req));
  }
  const next = user.status === 'active' ? 'closed' : 'active';
  users.setStatus(id, next);
  req.session.flash = [{
    type: next === 'closed' ? 'warning' : 'success',
    text: user.username + ' panel is now ' + next + '.'
  }];
  res.redirect(back(req));
}

// ---------------------------------------------------------------- delete
// Deleting a panel takes its whole downstream tree with it, exactly as the
// reference warning text promises.
function deleteCascade(req, res) {
  const me = res.locals.me;
  // Final Delete Permission Rule: deleting an account (and its whole downstream
  // tree of users and keys) is the controller's alone. No tier below it may
  // delete any data, so a hand-made post from a non-controller is refused here.
  if (!me || me.role !== 'controller') {
    req.session.flash = [{ type: 'danger', text: 'Only the controller can delete accounts.' }];
    return res.redirect(back(req));
  }
  const rootId = Number(req.body.root_id);

  if (!rootId || rootId === me.id || !owns(me, rootId)) {
    req.session.flash = [{ type: 'danger', text: 'That account cannot be deleted from here.' }];
    return res.redirect(back(req));
  }

  const victim = users.getById(rootId);
  const ids = subtreeIds(rootId);
  const marks = ids.map(() => '?').join(',');

  store.transaction(function () {
    store.run(`DELETE FROM keys WHERE created_by_id IN (${marks})`, ids);
    store.run(`DELETE FROM users WHERE id IN (${marks})`, ids);
  });

  req.session.flash = [{
    type: 'success',
    text: victim.username + ' and ' + (ids.length - 1) + ' account(s) below it were deleted.'
  }];
  res.redirect(back(req));
}

// ------------------------------------------------------------- direct login
// The controller steps straight into another panel's dashboard without typing
// that panel's password. The session's active uid becomes the target while the
// controller's own id is parked in `controllerUid`, so every page renders as the
// target and "Back to Controller" can restore the original login. The target's
// password_hash is never read or written.
function directLogin(req, res) {
  const me = res.locals.me;
  // Only the controller, at its own login, may start a Direct Login. While
  // impersonating, the active role is the target's, so this refuses — a tier
  // below the controller can never hop into another account.
  if (!me || me.role !== 'controller') {
    req.session.flash = [{ type: 'danger', text: 'Only the controller can use Direct Login.' }];
    return res.redirect('/home');
  }
  const targetId = Number(req.body.user_id);
  const target = users.getById(targetId);
  if (!target || !owns(me, targetId)) {
    req.session.flash = [{ type: 'danger', text: 'That account is not under your panel.' }];
    return res.redirect(back(req));
  }
  if (target.role === 'controller' || target.id === me.id) {
    req.session.flash = [{ type: 'warning', text: 'Pick a panel below the controller to enter.' }];
    return res.redirect(back(req));
  }

  const controllerId = me.id;
  // Fresh session id on the privilege change, then park the controller and swap
  // the active login to the target — no password involved.
  req.session.regenerate(function (err) {
    if (err) {
      req.session.flash = [{ type: 'danger', text: 'Could not start Direct Login. Try again.' }];
      return res.redirect('/home');
    }
    req.session.uid = target.id;
    req.session.controllerUid = controllerId;
    req.session.flash = [{ type: 'success', text: 'Direct Login: you are now inside ' + target.username + '’s panel.' }];
    res.redirect('/home');
  });
}

// --------------------------------------------------------- back to controller
// Restores the parked controller login, ending the impersonation. Available
// only while a Direct Login is active; the target's password stays untouched.
function backToController(req, res) {
  const controllerId = req.session && req.session.controllerUid;
  const controller = controllerId ? users.getById(controllerId) : null;
  if (!controller || controller.role !== 'controller') {
    req.session.flash = [{ type: 'warning', text: 'No Direct Login is active.' }];
    return res.redirect('/home');
  }
  req.session.regenerate(function (err) {
    if (err) {
      req.session.flash = [{ type: 'danger', text: 'Could not return to the controller. Try again.' }];
      return res.redirect('/home');
    }
    req.session.uid = controller.id;
    delete req.session.controllerUid;
    req.session.flash = [{ type: 'success', text: 'Welcome back, ' + controller.username + ' (Controller).' }];
    res.redirect('/home');
  });
}

module.exports = { LIST_PAGES, addForm, addSubmit, list, statusUpdate, deleteCascade, directLogin, backToController };
