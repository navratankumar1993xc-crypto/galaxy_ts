'use strict';
const store = require('../../db');
const payments = require('../queries/payments');
const users = require('../queries/users');
const { subtreeIds } = require('../queries/tree');
const { inr } = require('../config');

function back(req) {
  return req.get('referer') || '/transaction';
}

function flash(req, type, text) {
  req.session.flash = [{ type, text }];
}

function receiptShareMessage(sender, acceptedPayments) {
  const total = acceptedPayments.reduce(function (sum, p) { return sum + Number(p.amount); }, 0);
  return [
    'Payment received',
    'From: ' + sender.username,
    'Total: ' + inr(total)
  ].join('\n');
}

function flashAcceptedPayments(req, sender, acceptedPayments) {
  req.session.flash = [{
    type: 'success',
    text: acceptedPayments.length + ' pending payment(s) from ' + sender.username + ' accepted.',
    paymentReceipt: receiptShareMessage(sender, acceptedPayments)
  }];
}

// --------------------------------------------------------------- /transaction
function transaction(req, res) {
  res.render('tiers/transaction', { rows: payments.listInSubtree(res.locals.me.id) });
}

function paymentReceivingHistory(req, res) {
  const rows = store.all(
    `SELECT p.id, p.sender_id, p.amount, p.send_date, p.received_date,
            p.key_id, p.kind, p.is_renew, s.username AS sender, k.key_name
       FROM payments p
       JOIN users s ON s.id = p.sender_id
       LEFT JOIN keys k ON k.id = p.key_id
      WHERE p.receiver_id = ? AND p.status = 'Success' AND p.received_date IS NOT NULL
      ORDER BY p.received_date DESC, p.id DESC`,
    [res.locals.me.id]
  );
  const groupsByKey = new Map();
  rows.forEach(function (payment) {
    const date = String(payment.received_date).slice(0, 10);
    const key = payment.sender_id + '|' + payment.received_date;
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        sender: payment.sender,
        date,
        receivedAt: payment.received_date,
        totalAmount: 0,
        totalKeys: 0,
        payments: []
      };
      groupsByKey.set(key, group);
    }
    group.totalAmount += Number(payment.amount);
    if (payment.kind === 'due' || payment.key_id !== null) group.totalKeys++;
    group.payments.push(payment);
  });
  res.render('tiers/payment_receiving_history', { groups: Array.from(groupsByKey.values()) });
}

// A child settling up with its own parent: this only files the transfer, the
// parent still has to accept it via Receive Payment on their panel list.
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
    const pending = store.all(
      `SELECT id, amount FROM payments
        WHERE sender_id = ? AND receiver_id = ? AND status = 'Pending'
        ORDER BY id`,
      [senderId, me.id]
    );
    const n = payments.acceptAllFrom(senderId, me.id);
    if (n) {
      flashAcceptedPayments(req, sender, pending);
    } else {
      flash(req, 'warning', sender.username + ' has no pending payment to accept.');
    }
    return res.redirect(back(req));
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    flash(req, 'danger', 'Nothing to accept: the amount was empty.');
    return res.redirect(back(req));
  }

  const pendingRows = store.all(
    `SELECT id, amount FROM payments
      WHERE sender_id = ? AND receiver_id = ? AND status = 'Pending'
      ORDER BY id`,
    [senderId, me.id]
  );
  const pendingTotal = pendingRows.reduce(function (sum, p) { return sum + Number(p.amount); }, 0);
  if (pendingRows.length > 1 && amount === pendingTotal) {
    const n = payments.acceptAllFrom(senderId, me.id);
    if (n) flashAcceptedPayments(req, sender, pendingRows);
    else flash(req, 'warning', sender.username + ' has no pending payment to accept.');
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
    if (!payments.accept(pending.id, me.id)) {
      flash(req, 'warning', 'That payment is no longer pending.');
      return res.redirect(back(req));
    }
  } else {
    payments.recordBy(me.id, senderId, amount);
    // A payment big enough to take the due to zero settles the key bills under
    // it as well, so nothing is left saying Due after the money arrived.
    if (users.getById(senderId).due <= 0) payments.closeOpenDues(senderId, me.id);
  }

  req.session.flash = [{
    type: 'success',
    text: inr(amount) + ' accepted from ' + sender.username +
      '. Remaining due: ' + inr(users.getById(senderId).due) + '.',
    paymentReceipt: receiptShareMessage(sender, [{ amount }])
  }];
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
    return res.redirect('/transaction');
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

module.exports = {
  transaction, paymentReceivingHistory, sendPayment, acceptPayment, receipt, transferHistory
};
