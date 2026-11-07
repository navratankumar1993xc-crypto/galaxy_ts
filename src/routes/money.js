'use strict';
const store = require('../../db');
const payments = require('../queries/payments');
const users = require('../queries/users');
const { subtreeIds } = require('../queries/tree');
const { inr } = require('../config');

function back(req) {
  return req.get('referer') || '/payment_history';
}

function flash(req, type, text) {
  req.session.flash = [{ type, text }];
}

// --------------------------------------------------------------- /transaction
function transaction(req, res) {
  res.render('tiers/transaction', { rows: payments.listInSubtree(res.locals.me.id) });
}

// ----------------------------------------------------------- /payment_history
function paymentHistory(req, res) {
  const me = res.locals.me;
  res.render('tiers/payment_history', {
    // The controller has no parent, so its "send payment" card is not rendered.
    parent: me.parent_id ? users.getById(me.parent_id) : null,
    payers: payments.payersOf(me.id),
    board: payments.dueBoard(me.id, me.id),
    rows: payments.listInSubtree(me.id)
  });
}

// A child settling up with its own parent: this only files the transfer, the
// parent still has to accept it on their own /payment_history page.
function sendPayment(req, res) {
  const me = res.locals.me;
  if (!me.parent_id) {
    flash(req, 'danger', 'This panel has no parent to pay.');
    return res.redirect(back(req));
  }
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    flash(req, 'danger', 'Enter an amount greater than zero.');
    return res.redirect(back(req));
  }

  const id = payments.payUp(me, amount);
  flash(req, 'success',
    'Payment of ' + inr(amount) + ' sent to ' + users.getById(me.parent_id).username +
    ' (reference #' + id + '). It shows as Pending until they accept it.');
  res.redirect(back(req));
}

// The reference accepts in two shapes: an amount for one transfer, or all=1
// which settles every pending transfer that user has submitted.
function acceptPayment(req, res) {
  const me = res.locals.me;
  const senderId = Number(req.body.sender_id);
  const sender = users.getById(senderId);

  if (!sender || !subtreeIds(me.id).includes(senderId) || sender.parent_id !== me.id) {
    flash(req, 'danger', 'That payer is not directly under your panel.');
    return res.redirect(back(req));
  }

  if (req.body.all) {
    const n = payments.acceptAllFrom(senderId, me.id);
    flash(req, n ? 'success' : 'warning',
      n ? n + ' pending payment(s) from ' + sender.username + ' accepted.'
        : sender.username + ' has no pending payment to accept.');
    return res.redirect(back(req));
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    flash(req, 'danger', 'Nothing to accept: the amount was empty.');
    return res.redirect(back(req));
  }

  // Prefer the transfer the payer actually submitted, so its own dates and
  // status line up; otherwise record the payment on their behalf. When both a
  // key bill and a plain transfer match the amount, the bill goes first — it is
  // the row that also has to stop reading "Due".
  const pending = store.get(
    `SELECT * FROM payments
      WHERE sender_id = ? AND receiver_id = ? AND status = 'Pending' AND amount = ?
      ORDER BY (kind = 'due') DESC, id DESC LIMIT 1`,
    [senderId, me.id, amount]
  );

  if (pending) {
    payments.accept(pending.id, me.id);
  } else {
    payments.recordBy(me.id, senderId, amount);
    // A payment big enough to take the due to zero settles the key bills under
    // it as well, so nothing is left saying Due after the money arrived.
    if (users.getById(senderId).due <= 0) payments.closeOpenDues(senderId, me.id);
  }

  flash(req, 'success', inr(amount) + ' accepted from ' + sender.username +
    '. Remaining due: ' + inr(users.getById(senderId).due) + '.');
  res.redirect(back(req));
}

// --------------------------------------------------------------- /receipt
// The payment receipt: full detail of one ledger row — who paid, who received,
// how much and when it was received. Only the two parties of the payment and
// the controller (final control over the whole payment system) may open it;
// every other login is refused, so a receipt is never public.
function receipt(req, res) {
  const me = res.locals.me;
  const p = store.get(
    `SELECT p.*, s.username AS sender, s.role AS sender_role,
            r.username AS receiver, r.role AS receiver_role, k.key_name
       FROM payments p
       LEFT JOIN users s ON s.id = p.sender_id
       LEFT JOIN users r ON r.id = p.receiver_id
       LEFT JOIN keys k ON k.id = p.key_id
      WHERE p.id = ?`,
    [Number(req.query.id)]
  );
  if (!p || (me.id !== p.sender_id && me.id !== p.receiver_id && me.role !== 'controller')) {
    flash(req, 'danger', 'That receipt belongs to its sender, its receiver and the controller only.');
    return res.redirect('/payment_history');
  }
  res.render('tiers/receipt', { p });
}

// ----------------------------------------------------------- /transfer_history
// The controller's complete key-transfer trail: which key moved, from which
// panel to which, and how much of its account travelled with it.
function transferHistory(req, res) {
  const me = res.locals.me;
  if (me.role !== 'controller') {
    flash(req, 'danger', 'Only the controller can read the transfer history.');
    return res.redirect('/home');
  }
  res.render('tiers/transfer_history', { rows: require('../queries/keys').transferLog() });
}

module.exports = { transaction, paymentHistory, sendPayment, acceptPayment, receipt, transferHistory };
