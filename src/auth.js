'use strict';
const store = require('../db');
const users = require('./queries/users');
const prices = require('./queries/prices');
const keys = require('./queries/keys');
const tickets = require('./queries/tickets');
const { BRAND, ROLES, CHAIN_TIERS, bold, boldText, inr, ASSET_VERSION, ROOT } = require('./config');
const fs = require('fs');
const path = require('path');
const { menuFor } = require('./menu');

// The short names the key table's single tier dropdown offers, in chain order.
const PICK_LABEL = {
  developer: 'Developer',
  super_master_admin: 'Super Master',
  master_admin: 'Master',
  admin: 'Admin',
  super_seller: 'Super Seller'
};

// Re-read the account on every request so dues, status and role changes show up
// immediately without needing a fresh login.
function currentUser(req) {
  if (!req.session || !req.session.uid) return null;
  return store.get('SELECT * FROM users WHERE id = ?', [req.session.uid]);
}

function locals(req, res, next) {
  const me = currentUser(req);
  res.locals.me = me;
  // Direct Login (impersonation): the controller steps into another panel by
  // swapping the session's active uid while keeping its own id parked in
  // `controllerUid`. Every page then renders as the target user (currentUser
  // reads uid), and a "Back to Controller" banner restores the parked id. The
  // target's password is never read or changed.
  const controllerUid = req.session && req.session.controllerUid;
  const impersonator = controllerUid ? store.get('SELECT * FROM users WHERE id = ?', [controllerUid]) : null;
  res.locals.impersonator = impersonator && impersonator.role === 'controller' ? impersonator : null;
  res.locals.impersonating = !!(res.locals.impersonator && me && me.id !== res.locals.impersonator.id);
  res.locals.brand = BRAND;
  res.locals.brandBold = bold;
  res.locals.boldText = boldText;
  res.locals.inr = inr;
  res.locals.path = req.path;
  res.locals.assetV = ASSET_VERSION;
  // The login stylesheet carries its own cache-buster: its mtime is read per
  // request, so a redesign reaches the browser without a manual version bump.
  try {
    res.locals.loginCssV = Math.floor(fs.statSync(path.join(ROOT, 'public', 'css', 'login.css')).mtimeMs / 1000);
  } catch (err) {
    res.locals.loginCssV = 0;
  }
  res.locals.ROLES = ROLES;
  // The lineage columns the key tables print, in chain order, so a new tier
  // shows up in /all_key and /reports without editing either view. A seller is
  // the exception: it only deals with the super seller directly above it, so
  // the names of the developer, super master, master and admin tiers stay out
  // of its tables — it sees its own row and its super seller, nothing higher.
  res.locals.CHAIN_TIERS = me && me.role === 'seller'
    ? CHAIN_TIERS.filter(function (tier) {
        return tier.role === 'super_seller' || tier.role === 'seller';
      })
    : CHAIN_TIERS;
  // The key table prints the five tiers above the seller as ONE column, chosen
  // from a single dropdown, instead of five wide columns. The Seller column
  // stays on its own. A seller's dropdown offers only the super seller above it.
  res.locals.CHAIN_PICK_TIERS = res.locals.CHAIN_TIERS
    .filter(function (tier) { return tier.role !== 'seller'; })
    .map(function (tier) {
      return Object.assign({}, tier, { pickLabel: PICK_LABEL[tier.role] || tier.label });
    });
  res.locals.scripts = '';
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  if (me) {
    res.locals.roleName = (ROLES[me.role] || { label: me.role }).label;
    res.locals.menu = menuFor(me.role);
    res.locals.settings = prices.all();
    // The heading strip is the same on every page of the reference build.
    res.locals.panelTitle = res.locals.roleName + ' Panel';
    // Constant wording plus an integer, which is why pagehead can emit it with
    // <%- %> and keep the apostrophe exactly as the reference writes it.
    res.locals.resultChip = "\u{1F4CA} Today's Total Results: " +
      (me.role === 'controller' ? tickets.countToday() : 0);
  }
  // Treeview parents highlight when any child route is the active one.
  res.locals.treeActive = function (item) {
    return !!(item.tree && item.tree.some(c => c.match === req.path));
  };
  next();
}

function requireLogin(req, res, next) {
  if (currentUser(req)) return next();
  req.session.flash = [{ type: 'warning', text: 'Please login first.' }];
  return res.redirect('/login');
}

function requireRole(...roles) {
  return function (req, res, next) {
    const me = currentUser(req);
    if (!me || !roles.includes(me.role)) {
      return res.status(403).render('error', { code: 403, message: 'Your role cannot open this page.' });
    }
    return next();
  };
}

// Keeps dues, suspended keys and panel closures consistent on every page render.
function enforceRules(req, res, next) {
  const me = currentUser(req);
  if (me) {
    keys.enforceCascades(prices.all());
    // A panel with no outstanding due is open again.
    if (me.status === 'closed' && me.due <= 0) users.setStatus(me.id, 'active');
  }
  next();
}

module.exports = { currentUser, locals, requireLogin, requireRole, enforceRules };
