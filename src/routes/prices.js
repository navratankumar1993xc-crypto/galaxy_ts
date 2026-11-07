'use strict';
const prices = require('../queries/prices');
const { ROLE_ORDER, roleLabel } = require('../config');

function back(req) {
  return req.get('referer') || '/set_price';
}

function flash(req, type, text) {
  req.session.flash = [{ type, text }];
}

// -------------------------------------------------------------- /set_price
function page(req, res) {
  res.render('controller/set_price', {
    settings: prices.all(),
    priceRows: prices.priceTable(),
    ROLE_ORDER
  });
}

// Three different forms share this page: the price row, the key grace timer
// and the child panel grace timer. The grace forms carry a hidden `op`; the
// price form is the only one left.
function save(req, res) {
  const settings = prices.all();

  // The three forms on the page differ only by the fields they carry, so the
  // field name is what tells them apart - no extra hidden marker is posted.
  if (req.body.grace_hours !== undefined) {
    const hours = Number(req.body.grace_hours);
    if (!Number.isFinite(hours) || hours < 0) {
      flash(req, 'danger', 'Enter the key deactivation time in whole hours.');
      return res.redirect(back(req));
    }
    prices.set('key_grace_hours', Math.round(hours));
    flash(req, 'success', 'Unpaid or expired keys now auto-suspend after ' +
      Math.round(hours) + ' hours.');
    return res.redirect(back(req));
  }

  if (req.body.child_grace_hours !== undefined) {
    const hours = Number(req.body.child_grace_hours);
    if (!Number.isFinite(hours) || hours < 0) {
      flash(req, 'danger', 'Enter the child panel grace time in whole hours.');
      return res.redirect(back(req));
    }
    prices.set('child_grace_hours', Math.round(hours));
    flash(req, 'success', 'Keys under a closed panel now survive ' +
      Math.round(hours) + ' hours.');
    return res.redirect(back(req));
  }

  const role = String(req.body.role || '');
  const price = Number(req.body.price);
  const cutoff = Number(req.body.cutoff_hour) || 0;
  if (!ROLE_ORDER.includes(role) || !Number.isFinite(price) || price < 0) {
    flash(req, 'danger', 'Pick a role and enter a price first.');
    return res.redirect(back(req));
  }

  prices.savePrice(role, price, cutoff);
  flash(req, 'success', roleLabel(role) + ' panel price set to Rs ' +
    Math.round(price) + ', closing at ' + prices.cutoffLabel(cutoff) +
    '. Panels created from now on start with that due.');
  res.redirect(back(req));
}

module.exports = { page, save };
