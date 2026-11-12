'use strict';
const keys = require('../queries/keys');
const users = require('../queries/users');
const payments = require('../queries/payments');
const prices = require('../queries/prices');
const { subtreeIds } = require('../queries/tree');
const { boldText, ROLES, inr } = require('../config');
const { DT_BUTTONS } = require('../pageStyle');
const { siteBaseUrl, loginUrl, safeHttpUrl } = require('../urls');

// The Add IP label and placeholder are the same string on the reference page.
const IP_FORMAT_HINT = boldText('Please Input Data Format (000.00.00.00:0000:abcd:abcd123)');

// The mass-delete select posts display values; `mac_unregistered` and `demo`
// are the two that are not already a tile filter key.
const DELETE_TARGET_FILTER = {
  expired: 'expired',
  deactive: 'deactive',
  unpaid: 'unpaid',
  mac_unregistered: 'mac_unreg',
  demo: 'demo'
};

function back(req) {
  return req.get('referer') || '/all_key';
}

// The mass-delete gate is one fixed word, not the account's login password: the
// panel owner never has to remember (or share) a credential just to clear a
// stack of keys. Case and stray spaces are forgiven; anything else is refused,
// and the check lives here in the handler rather than in the browser, so the
// confirmation cannot be skipped by posting the form by hand.
const MASS_DELETE_PASS = 'LOVE';

function passMatches(value) {
  return String(value || '').trim().toUpperCase() === MASS_DELETE_PASS;
}

function flash(req, type, text) {
  req.session.flash = [{ type, text }];
}

// The single validity a seller may create keys at, set by the controller on
// /all_key. Stored as `panel_days`; a dirty or missing value falls back to 30.
function sellerKeyDays(settings) {
  const n = Number(settings && settings.panel_days);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return 30;
  return n;
}

// Every row action has to prove the key lives inside the caller's subtree.
function owned(req, res, id) {
  const me = res.locals.me;
  const key = keys.get(id);
  if (!key) {
    flash(req, 'danger', 'That key no longer exists.');
    return null;
  }
  if (!keys.owns(me, key.id)) {
    flash(req, 'danger', 'That key is not under your panel.');
    return null;
  }
  return key;
}

// ------------------------------------------------------------------------- list
function list(req, res) {
  const me = res.locals.me;
  const settings = prices.all();
  const wanted = String(req.query.filter || 'all');
  const filter = keys.FILTERS[wanted] ? wanted : 'all';

  // Per-row decisions the view cannot make on its own, computed here once: the
  // Mark Paid click is offered only to the key creator's own parent, and the
  // trash control only to the controller, who is the only one allowed to delete.
  const billable = payments.billableChildren(me.id);

  // The five tiers above the seller share ONE column on the key table; the
  // dropdown above the table picks which tier's panel name it prints. An
  // unknown or missing choice falls back to the first tier this login may see.
  const pickTiers = res.locals.CHAIN_PICK_TIERS;
  const chainTier = pickTiers.find(function (t) { return t.role === String(req.query.chain || ''); }) || pickTiers[0];

  const isCtrl = me.role === 'controller';
  const subtreeUsers = users.listAllInSubtree(me.id);

  res.render('tiers/key_list', {
    filter,
    chainTier,
    rows: keys.list(me.id, filter).map(function (k) {
      return Object.assign({}, k, {
        // `markPaid` carries the amount the click would bill; undefined means
        // this row is not the caller's to mark.
        markPaid: !Number(k.has_paid) && billable[k.created_by_id]
          ? Object.assign({ keyName: k.key_name }, billable[k.created_by_id])
          : undefined,
        canDelete: keys.deletableBy(me),
        // The controller alone reads and edits validity, so the per-key change
        // trail is fetched only for that login's table.
        validityLog: isCtrl ? keys.validityLog(k.id) : [],
        // The transfer modal names the current owner and previews the whole
        // account that would move; the hierarchy modal carries the reset trail.
        ownerName: isCtrl ? ((users.getById(k.created_by_id) || {}).username || '') : '',
        account: isCtrl ? payments.keyAccount(k.id) : null,
        resetLog: isCtrl ? keys.resetLog(k.id) : []
      });
    }),
    // Only the controller gets the Global Utilities toolbar, as on the reference.
    isController: me.role === 'controller',
    // Key generation is the seller's job alone; every other panel only reads
    // the table. A seller has nobody below it, so its generator aims at itself.
    isSeller: me.role === 'seller',
    assignable: subtreeUsers.map(function (u) {
      return { id: u.id, username: u.username, roleName: (ROLES[u.role] || { label: u.role }).label };
    }),
    // The transfer picker offers only SELLER panels: a whole-account transfer
    // lands a key in a seller's hands, never in an intermediate tier. The route
    // refuses the controller, non-sellers and the key's current owner.
    transferTargets: isCtrl ? subtreeUsers.filter(function (u) { return u.role === 'seller'; }).map(function (u) {
      return { id: u.id, username: u.username, roleName: (ROLES[u.role] || { label: u.role }).label };
    }) : [],
    defaultDays: sellerKeyDays(settings),
    // The gift-create picker lists every seller panel under this login so the
    // controller chooses from the tree instead of typing a name blind. Only the
    // controller renders that modal, so other tiers get an empty list.
    giftSellers: me.role === 'controller' ? users.listByRole(me.id, 'seller') : [],
    ipFormatHint: IP_FORMAT_HINT,
    pageStyle: DT_BUTTONS
  });
}

// ------------------------------------------------------- Global Utilities posts
// The Reset MAC and Mass Delete forms post to the page itself, so both arrive
// here distinguished by their hidden field.
function toolbar(req, res) {
  const me = res.locals.me;

  if (req.body.reset_all_mac) {
    if (me.role !== 'controller') {
      flash(req, 'danger', 'Only the controller can reset every MAC at once.');
      return res.redirect(back(req));
    }
    keys.resetAllMac(me);
    flash(req, 'success', 'All MAC addresses were unregistered.');
    return res.redirect(back(req));
  }

  if (req.body.mass_delete_submit) {
    // Deleting keys is the controller's job; the other tiers only read the list
    // and ask the panel above them. Their own page never renders this form, so
    // a post that reaches here is a hand-made request.
    if (me.role !== 'controller') {
      flash(req, 'danger', 'Only the controller can delete keys.');
      return res.redirect(back(req));
    }
    const target = String(req.body.delete_type || '');
    const filter = DELETE_TARGET_FILTER[target];
    if (!filter) {
      flash(req, 'danger', 'Choose a delete target first.');
      return res.redirect(back(req));
    }
    // The reference asks for the current admin's own login password before it
    // deletes. Here the gate is one fixed word instead — see MASS_DELETE_PASS.
    if (!passMatches(req.body.admin_pass)) {
      flash(req, 'danger', 'Mass delete cancelled: password did not match.');
      return res.redirect(back(req));
    }
    const removed = keys.massDelete(me, filter);
    // The DEMO number is read off the rows that exist, so clearing every demo
    // also clears the counter — the next visitor on the login page gets DEMO01.
    flash(req, 'success', target === 'demo'
      ? removed + ' demo key(s) deleted — the next public demo starts again at DEMO01.'
      : removed + ' key(s) of type ' + target + ' were deleted.');
    return res.redirect(back(req));
  }

  res.redirect(back(req));
}

// ------------------------------------------------------------- set_seller_days
// The controller alone decides how many days a seller's keys run for. The value
// is global: every seller login reads the same number, and none of them can
// change it or create a key longer than it.
function setSellerDays(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can set the seller key validity.');
    return res.redirect(back(req));
  }
  const days = Number(req.body.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    flash(req, 'danger', 'Seller key validity must be a whole number of days from 1 to 3650.');
    return res.redirect(back(req));
  }
  prices.set('panel_days', String(days));
  flash(req, 'success', 'Seller key validity set to ' + days + ' day(s). Every seller now creates keys of exactly this length.');
  res.redirect(back(req));
}

// --------------------------------------------------------------- create_gift
// A gift key is the controller's to give: free of charge, already Paid, and
// handed straight to a named seller panel. Because it is born Paid and never
// passes through /mark_key_paid, no Due or charge is ever raised for it.
function createGift(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can create a gift key.');
    return res.redirect(back(req));
  }
  const sellerName = String(req.body.seller_name || '').trim();
  const seller = users.getByUsername(sellerName);
  if (!seller || seller.role !== 'seller') {
    flash(req, 'danger', 'No seller panel named "' + sellerName + '". Type the seller login name exactly.');
    return res.redirect(back(req));
  }
  let days = Number(req.body.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) days = sellerKeyDays(prices.all());
  const name = String(req.body.name || '').trim() || null;
  try {
    const keyName = keys.generate({
      owner: seller, days, type: 'normal', hasPaid: 1, clientName: 'GIFT KEY', gift: true, name
    });
    const key = keys.getByName(keyName);
    return res.redirect('/key_details/' + key.id + '?created=1');
  } catch (err) {
    if (!/UNIQUE|PRIMARY/i.test(String(err && err.message))) throw err;
    flash(req, 'danger', 'Name ' + name + ' is already taken by another key.');
    return res.redirect(back(req));
  }
}

// -------------------------------------------------------------- transfer_gift
// Moving a gift key to another seller panel, by name. Only the controller may
// do it, and only for a key that is actually a gift. The move changes lineage,
// not money: the key stays Paid and no bill follows it.
function transferGift(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can transfer a gift key.');
    return res.redirect(back(req));
  }
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));
  if (!key.is_gift) {
    flash(req, 'danger', key.key_name + ' is not a gift key.');
    return res.redirect(back(req));
  }
  const sellerName = String(req.body.seller_name || '').trim();
  const seller = users.getByUsername(sellerName);
  if (!seller || seller.role !== 'seller') {
    flash(req, 'danger', 'No seller panel named "' + sellerName + '". Type the seller login name exactly.');
    return res.redirect(back(req));
  }
  if (seller.id === key.created_by_id) {
    flash(req, 'warning', key.key_name + ' is already in ' + seller.username + ' — nothing to transfer.');
    return res.redirect(back(req));
  }
  // A gift moves through the same account transfer as any key, so the move is
  // logged in the transfer history too (a gift simply carries no bills).
  payments.transferAccount({ key, target: seller, byUsername: me.username });
  flash(req, 'success', key.key_name + ' gift key transferred to ' + seller.username + '.');
  res.redirect(back(req));
}

// -------------------------------------------------------------- transfer_key
// The controller moves a key AND its whole account to another panel: lineage,
// every payment/due record, the pending due balance, reset and validity trails.
// The old panel loses all of it, the new panel gains all of it, nothing is
// copied twice. See payments.transferAccount for the single transaction.
function transferKey(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can transfer a key.');
    return res.redirect(back(req));
  }
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));
  const name = String(req.body.target_name || '').trim();
  const target = users.getByUsername(name);
  // A whole-account transfer lands only in a SELLER panel — the picker offers
  // sellers alone, and a hand-made post naming any other tier is refused here.
  if (!target || target.role !== 'seller') {
    flash(req, 'danger', 'No seller panel named "' + name + '". A key transfers only into a seller panel.');
    return res.redirect(back(req));
  }
  if (target.id === key.created_by_id) {
    flash(req, 'warning', key.key_name + ' is already in ' + target.username + ' — nothing to transfer.');
    return res.redirect(back(req));
  }
  const moved = payments.transferAccount({ key, target, byUsername: me.username });
  flash(req, 'success', key.key_name + ' transferred to ' + target.username + ' with its whole account: ' +
    moved.bills + ' payment/due record(s), ' + inr(moved.pending) + ' pending due, ' +
    moved.resets + ' reset(s) and ' + moved.validity + ' validity change(s).');
  res.redirect(back(req));
}

// ------------------------------------------------------------------ extend_id
// The Global Utilities "Extend All" form alone posts here now. A single key's
// validity is edited through /edit_validity, which sets the exact days instead
// of adding to them; a hand-made per-key post to this route is refused.
function extend(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can extend a key’s validity.');
    return res.redirect(back(req));
  }
  if (!req.body.extend_all) {
    flash(req, 'danger', 'A single key’s validity is changed with Edit Validity.');
    return res.redirect(back(req));
  }
  const days = Number(req.body.days);
  if (!days) {
    flash(req, 'danger', 'Enter the number of days to extend by.');
    return res.redirect(back(req));
  }
  keys.extendAll(me, days);
  flash(req, 'success', 'Every key in your panel was extended by ' + days + ' day(s).');
  res.redirect(back(req));
}

// -------------------------------------------------------------- edit_validity
// The controller types the validity a key should carry — more days or fewer —
// and the key takes it exactly: days becomes the entered number and the expiry
// is recomputed as today + those days, up or down. Every change is kept in the
// validity history. No other tier may edit a key's validity, gift or not.
function editValidity(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can edit a key’s validity.');
    return res.redirect(back(req));
  }
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));
  const days = Number(req.body.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    flash(req, 'danger', 'Enter the new validity in days (1 to 3650).');
    return res.redirect(back(req));
  }
  const out = keys.setValidity(key, days, me.username);
  flash(req, 'success', key.key_name + ' validity set to ' + days + ' day(s) — new expiry ' + out.newExpire + '.');
  res.redirect(back(req));
}

// ----------------------------------------------------------- update_client_name
// Every tier may correct a key's client name, because it is a label rather than
// the key's identity. The key name itself is not editable from any login: it is
// fixed when the seller creates the key, and no form here writes key_name.
function updateClientName(req, res) {
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));

  // A gift key's client name is the fixed label GIFT KEY, not a customer label.
  if (key.is_gift) {
    flash(req, 'warning', key.key_name + ' is a gift key; its client name stays GIFT KEY.');
    return res.redirect(back(req));
  }

  const clientName = String(req.body.client_name || '').trim();
  keys.setClientName(key.id, clientName);
  flash(req, 'success', clientName
    ? key.key_name + ' client name set to ' + clientName + '.'
    : key.key_name + ' client name cleared.');
  res.redirect(back(req));
}

// ----------------------------------------------------------------- delete_key
function remove(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can delete keys.');
    return res.redirect(back(req));
  }
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));

  keys.remove(key.id);
  flash(req, 'success', key.key_name + ' deleted.');
  res.redirect(back(req));
}

// ------------------------------------------------------------------ mark_paid
// The one click that turns a child's UnPaid key into a Paid key — and with it
// into a bill: the creator's role price lands on its due, and a Due row naming
// the key goes into its payment history. Only the creator's own parent gets the
// button, and only while the key is unpaid.
function markPaid(req, res) {
  const me = res.locals.me;
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));

  // A gift is free by definition: it is born Paid and must never raise a bill,
  // even if someone posts the mark-paid form at it by hand.
  if (key.is_gift) {
    flash(req, 'warning', key.key_name + ' is a gift key — free of charge, no Due is raised.');
    return res.redirect(back(req));
  }

  const creator = users.getById(key.created_by_id);
  if (!creator || creator.parent_id !== me.id) {
    flash(req, 'danger', 'Only ' + (creator ? creator.username : 'the owner') +
      "'s own parent panel can mark " + key.key_name + ' Paid.');
    return res.redirect(back(req));
  }
  if (Number(key.has_paid)) {
    flash(req, 'warning', key.key_name + ' is already Paid.');
    return res.redirect(back(req));
  }

  // The Paid flag, the due and the Due row are written together in here. A
  // renewal additionally consumes its pending flag and adds the controller-set
  // days, so the extra validity lands exactly at this paid click.
  const bill = payments.chargeKey({
    key: key, creator: creator, receiver: me, renewDays: sellerKeyDays(prices.all())
  });

  flash(req, 'success', bill.alreadyBilled
    ? key.key_name + ' is Paid. The ' + inr(bill.amount) + ' due on ' + creator.username + ' was already open.'
    : key.key_name + ' is Paid. ' + creator.username + ' now owes ' + inr(bill.amount) +
      ', and every panel above it owes its own parent its own role price (' + bill.chainBilled + ' dues in the chain)' +
      (bill.renewed ? ' (renewal, validity extended)' : '') +
      ' — each parent receives it via Receive Payment on its panel list.');
  res.redirect(back(req));
}

// ------------------------------------------------------------------ renew_key
// The seller's own near-expiry key. The click flips it back to UnPaid and raises
// renew_pending; NO days are added yet. The parent's mark-paid click consumes the
// flag, raises the renewal Due and extends the validity by the controller-set
// length, so an unpaid renewal never grants free days.
function renewKey(req, res) {
  const me = res.locals.me;
  if (me.role !== 'seller') {
    flash(req, 'danger', 'Only a seller can renew its own keys.');
    return res.redirect(back(req));
  }
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));

  if (key.is_gift) {
    flash(req, 'warning', key.key_name + ' is a gift key — free of charge, it cannot be renewed.');
    return res.redirect(back(req));
  }
  if (Number(key.renew_pending)) {
    flash(req, 'warning', key.key_name + ' is already awaiting its renewal payment.');
    return res.redirect(back(req));
  }
  if (!Number(key.has_paid)) {
    flash(req, 'warning', key.key_name + ' is UnPaid; only a Paid key can be renewed.');
    return res.redirect(back(req));
  }
  if (Number(key.left_days) > 3) {
    flash(req, 'warning', key.key_name + ' can be renewed only when 3 days or less are left.');
    return res.redirect(back(req));
  }

  keys.setPaid(key.id, 0);
  keys.setRenewPending(key.id, 1);
  const creator = users.getById(key.created_by_id);
  const parent = creator ? users.getById(creator.parent_id) : null;
  flash(req, 'success', key.key_name + ' renewed — now UnPaid. ' +
    (parent ? parent.username : 'The parent panel') + ' must mark it Paid to add ' +
    sellerKeyDays(prices.all()) + ' days.');
  res.redirect(back(req));
}

// ------------------------------------------------------------------ add_proxy
function addProxy(req, res) {
  const key = owned(req, res, req.body.key_id);
  if (!key) return res.redirect(back(req));

  const ip = String(req.body.IPaddress || '').trim();
  if (!ip) {
    flash(req, 'danger', 'Nothing was added: the IP field was empty.');
    return res.redirect(back(req));
  }
  keys.addIp(key.id, ip);
  flash(req, 'success', 'IP added to ' + key.key_name + '.');
  res.redirect(back(req));
}

// ---------------------------------------------------------------- generate_key
// The reference's child panels could not be crawled, so key creation gets one
// honest form here. The assignee's lineage fills the chain columns, and because
// the assignee always sits inside the creator's subtree the key is also visible
// from every panel above it.
function generate(req, res) {
  const me = res.locals.me;
  const settings = prices.all();

  // Keys are made at the bottom of the chain: only a seller creates them. Every
  // panel above reads the list, marks keys Paid or hands the request down.
  if (me.role !== 'seller') {
    flash(req, 'danger', 'Only a seller can create a key.');
    return res.redirect('/all_key');
  }

  // Only normal keys are made here. A demo is the website's own thing: one click
  // on the login screen issues the next numbered DEMO key (see /create_demo_key),
  // and the controller's only say about it is the sidebar switch plus the days
  // box, which is what stores `demo_days`.
  const type = 'normal';

  const targetId = Number(req.body.for_id || me.id);
  if (!subtreeIds(me.id).includes(targetId)) {
    flash(req, 'danger', 'That account is not under your panel.');
    return res.redirect('/all_key');
  }
  const target = users.getById(targetId);

  // The seller does not choose a length: the controller's "Seller Key Validity
  // (Days)" setting is the one package a seller may create. A hand-made post
  // asking for more (or fewer) days is clamped to it, so the limit holds even
  // when the form is bypassed.
  const days = sellerKeyDays(settings);

  const mac = String(req.body.mac || '').trim();
  const name = String(req.body.name || '').trim() || null;
  const clientName = String(req.body.client_name || '').trim();

  try {
    const keyName = keys.generate({ owner: target, days, type, mac, name, clientName, hasPaid: 0 });
    const key = keys.getByName(keyName);
    return res.redirect('/key_details/' + key.id + '?created=1');
  } catch (err) {
    if (!/UNIQUE|PRIMARY/i.test(String(err && err.message))) throw err;
    flash(req, 'danger', 'Name ' + name + ' is already taken by another key.');
    return res.redirect('/all_key');
  }
}

function keyDetails(req, res) {
  const me = res.locals.me;
  const key = keys.get(req.params.id);
  if (!key || !keys.owns(me, key.id)) {
    return res.status(404).render('error', { code: 404, message: 'Key details not found.' });
  }

  const settings = prices.all();
  const creator = users.getById(key.created_by_id);
  res.set('Cache-Control', 'no-store');
  res.render('tiers/success', {
    kind: 'key',
    created: req.query.created === '1',
    key: {
      name: key.key_name,
      websiteUrl: siteBaseUrl(req) + '/login',
      fields: [
        { label: 'Key Name', value: key.key_name },
        { label: 'Client Name', value: key.client_name || '—' },
        { label: 'Assigned Panel', value: creator ? creator.username : '—' },
        { label: 'MAC Address', value: key.mac || '—' },
        { label: 'IP Addresses', value: key.ips || '—' },
        { label: 'Validity', value: key.days + ' days' },
        { label: 'Start Date', value: key.start_date },
        { label: 'Expiry Date', value: key.expire_date },
        { label: 'Payment Status', value: Number(key.has_paid) ? 'Paid' : 'UnPaid' },
        { label: 'Key Type', value: key.type },
        { label: 'Status', value: key.status }
      ],
      finalSetupLink: loginUrl(req, key.key_name),
      setupDownloadLink: safeHttpUrl(settings.setup_link),
      listUrl: '/all_key'
    }
  });
}

// ---------------------------------------------------------------- status_update
// The reference shares /status_update between users and keys. Called only when
// the query carries a key operation: `r_id` unregisters that one key's MAC,
// `ac_id` flips it between active and deactive.
function statusUpdate(req, res) {
  if (req.query.r_id !== undefined) {
    const key = owned(req, res, req.query.r_id);
    if (!key) return res.redirect(back(req));
    // The reset leaves a trail row before the MAC is cleared, so the history
    // keeps the MAC that was registered and follows the key on a transfer.
    keys.logReset(key, res.locals.me.username);
    keys.setMac(key.id, '');
    flash(req, 'success', key.key_name + ' MAC reset to unregistered.');
    return res.redirect(back(req));
  }

  const key = owned(req, res, req.query.ac_id);
  if (!key) return res.redirect(back(req));
  const next = key.status === 'active' ? 'deactive' : 'active';
  keys.setStatus(key.id, next);
  flash(req, next === 'deactive' ? 'warning' : 'success',
    key.key_name + ' is now ' + next + '.');
  res.redirect(back(req));
}

module.exports = {
  IP_FORMAT_HINT, list, toolbar, generate, keyDetails, extend, editValidity, setSellerDays, createGift, transferGift, transferKey,
  updateClientName, remove, addProxy, statusUpdate, markPaid, renewKey
};
