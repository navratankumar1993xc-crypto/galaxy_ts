'use strict';
const store = require('../../db');
const { subtreeIds, inClause } = require('./tree');
const users = require('./users');
const prices = require('./prices');
const keys = require('./keys');

// /transaction shows settled rows; /payment_history shows who owes what.
function listInSubtree(rootId) {
  const { sql, params } = inClause(subtreeIds(rootId));
  return store.all(
    `SELECT p.*, s.username AS sender, r.username AS receiver, k.key_name
       FROM payments p
       LEFT JOIN users s ON s.id = p.sender_id
       LEFT JOIN users r ON r.id = p.receiver_id
       LEFT JOIN keys k ON k.id = p.key_id
      WHERE p.sender_id IN (${sql}) OR p.receiver_id IN (${sql})
      ORDER BY p.id DESC`,
    [...params, ...params]
  );
}

// A child pays its own parent, at the price set for the child's role.
function payUp(sender, amount) {
  if (!sender.parent_id) return null;
  const info = store.run(
    `INSERT INTO payments (sender_id, receiver_id, amount, send_date, status)
     VALUES (?,?,?, datetime('now','localtime'), 'Pending')`,
    [sender.id, sender.parent_id, Number(amount) || 0]
  );
  return Number(info.lastInsertRowid);
}

function accept(paymentId, byUserId) {
  const p = store.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
  if (!p || p.status !== 'Pending') return false;
  if (p.receiver_id !== byUserId) return false;
  store.transaction(() => {
    store.run(
      `UPDATE payments SET status = 'Success', received_date = datetime('now','localtime') WHERE id = ?`,
      [paymentId]
    );
    users.subDue(p.sender_id, p.amount);
  });
  return true;
}

// "1-Click Accept" on the reference clears every pending payment from one user.
function acceptAllFrom(senderId, byUserId) {
  const pending = store.all(
    `SELECT * FROM payments WHERE sender_id = ? AND receiver_id = ? AND status = 'Pending'`,
    [senderId, byUserId]
  );
  store.transaction(() => {
    for (const p of pending) {
      store.run(
        `UPDATE payments SET status = 'Success', received_date = datetime('now','localtime') WHERE id = ?`,
        [p.id]
      );
      users.subDue(senderId, p.amount);
    }
  });
  return pending.length;
}

// The controller can also record a payment on someone's behalf.
function recordBy(receiverId, senderId, amount) {
  const info = store.run(
    `INSERT INTO payments (sender_id, receiver_id, amount, send_date, received_date, status)
     VALUES (?,?,?, datetime('now','localtime'), datetime('now','localtime'), 'Success')`,
    [senderId, receiverId, Number(amount) || 0]
  );
  users.subDue(senderId, amount);
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Key bills
//
// A child panel's keys stay UnPaid until the panel directly above it marks them
// Paid. That single click flips the key to Paid AND bills the WHOLE chain: the
// creator and every panel above it, up to (never including) the controller,
// each owe their own parent their own role price. Every bill is a Due row in
// its sender's payment history, and each parent receives it with the Accept
// button it already had. The controller is the top authority: it receives but
// is never billed.
// ---------------------------------------------------------------------------

// Who the caller may bill, and how much: every direct child, priced by the
// child's own role on /set_price. The key list reads this as a lookup table
// keyed by user id, so a row can only offer Mark Paid to its creator's parent.
function billableChildren(rootId) {
  return store.all(
    `SELECT u.id, u.username, u.role, rp.price
       FROM users u LEFT JOIN role_prices rp ON rp.role = u.role
      WHERE u.parent_id = ?`,
    [rootId]
  ).reduce(function (out, child) {
    out[child.id] = { username: child.username, role: child.role, price: Number(child.price || 0) };
    return out;
  }, {});
}

// The bill itself, raised against a key that is being marked Paid. The flag and
// the money are one event: they are written inside the same transaction, so a
// key is never left Paid with no bill, or billed against a key still UnPaid.
// Re-billing the same key is refused rather than doubled: an open Due row means
// the money for that key is still owed, so only the flag needed setting.
function chargeKey({ key, creator, receiver, renewDays = 0 }) {
  // A renewal is a fresh billing event: the seller already flipped the key back
  // to UnPaid, so the parent's click owes a new Due AND the promised extra days.
  const renewing = Number(key.renew_pending) === 1 && Number(renewDays) > 0;
  const open = store.get(
    `SELECT * FROM payments WHERE key_id = ? AND kind = 'due' AND status = 'Pending'`,
    [key.id]
  );
  if (open && !renewing) {
    keys.setPaid(key.id, 1);
    return { paymentId: Number(open.id), amount: Number(open.amount), alreadyBilled: true };
  }

  // One bill per chain level: the creator first, then each ancestor, each at
  // its OWN role price and owed to its OWN parent. The walk stops before the
  // controller — the highest authority never carries a Due.
  const chain = [];
  let node = creator;
  while (node && node.role !== 'controller' && node.parent_id) {
    const parent = users.getById(node.parent_id);
    if (!parent) break;
    chain.push({ sender: node, receiver: parent, amount: Number(prices.priceOf(node.role).price || 0) });
    node = parent;
  }

  const amount = chain.length ? chain[0].amount : 0;
  let paymentId = null;
  store.transaction(function () {
    keys.setPaid(key.id, 1);
    if (renewing) {
      // The days land only now, at the paid click, and the flag is consumed so a
      // second mark-paid cannot grant them again. The extension is a validity
      // change like any other, so it goes into the key's validity history too.
      const newExpire = keys.extendedExpire(key.expire_date, renewDays);
      keys.extend(key.id, renewDays);
      keys.setRenewPending(key.id, 0);
      keys.logValidity(key, receiver.username, Number(key.days) + Number(renewDays), newExpire, 'renew');
    }
    for (const bill of chain) {
      users.addDue(bill.sender.id, bill.amount);
      const id = Number(store.run(
        `INSERT INTO payments (sender_id, receiver_id, amount, send_date, status, key_id, kind, is_renew)
         VALUES (?,?,?, datetime('now','localtime'), 'Pending', ?, 'due', ?)`,
        [bill.sender.id, bill.receiver.id, bill.amount, key.id, renewing ? 1 : 0]
      ).lastInsertRowid);
      if (paymentId === null) paymentId = id;
    }
  });
  return { paymentId: paymentId, amount: amount, alreadyBilled: false, renewed: renewing, chainBilled: chain.length };
}

// Open key bills for one child, oldest first — the list a parent sees as "what
// this panel owes me, and for which key".
function openDues(senderId, receiverId) {
  return store.all(
    `SELECT p.*, k.key_name FROM payments p
       LEFT JOIN keys k ON k.id = p.key_id
      WHERE p.sender_id = ? AND p.receiver_id = ? AND p.kind = 'due' AND p.status = 'Pending'
      ORDER BY p.id`,
    [senderId, receiverId]
  );
}

// A transfer big enough to clear a child's whole due clears its key bills too.
// They are what the money was for, and a row still reading "Due" after the
// payment landed would be a lie in the child's history.
function closeOpenDues(senderId, receiverId) {
  return Number(store.run(
    `UPDATE payments SET status = 'Success', received_date = datetime('now','localtime')
      WHERE sender_id = ? AND receiver_id = ? AND kind = 'due' AND status = 'Pending'`,
    [senderId, receiverId]
  ).changes);
}

// One row per user in the subtree, carrying that user's due and latest payment.// Matches the reference layout, where a user with nothing owed reads "Clear / No Due".
// `receiverId` is the viewer, whose pending transfers decide the 1-Click button.
function dueBoard(rootId, receiverId) {
  const { sql, params } = inClause(subtreeIds(rootId).filter(id => id !== rootId));
  if (!params.length) return [];
  return store.all(
    `SELECT u.id, u.username, u.role, u.due, u.status,
            (SELECT COUNT(*) FROM payments q
              WHERE q.sender_id = u.id AND q.receiver_id = ? AND q.status = 'Pending') AS pending,
            p.sender_id   AS paid_by_id,
            p.receiver_id AS accepted_by_id,
            ps.username   AS paid_by,
            pr.username   AS accepted_by,
            p.amount, p.send_date, p.received_date, p.status AS payment_status, p.id AS payment_id
       FROM users u
       LEFT JOIN payments p ON p.id = (
              SELECT id FROM payments x WHERE x.sender_id = u.id ORDER BY x.id DESC LIMIT 1)
       LEFT JOIN users ps ON ps.id = p.sender_id
       LEFT JOIN users pr ON pr.id = p.receiver_id
      WHERE u.id IN (${sql})
      ORDER BY u.due DESC, u.username`,
    [receiverId, ...params]
  );
}

// Users eligible to pay the requester, for the /payment_history sender dropdown.
function payersOf(rootId) {
  const { sql, params } = inClause(subtreeIds(rootId).filter(id => id !== rootId));
  if (!params.length) return [];
  return store.all(
    `SELECT id, username, role, due FROM users WHERE id IN (${sql}) ORDER BY username`,
    params
  );
}

// ---------------------------------------------------------------------------
// Complete key transfer: the key does not move alone — its whole account moves
// with it. Every payment row carrying the key (the Due bills and the settled
// receipts alike) is re-pointed to the new creator and its new parent, so the
// new panel's Transaction / Payment / Due histories show the entire old trail
// and the old panel's histories lose it. Rows are UPDATEd, never copied, so no
// record exists in two panels at once. A Pending due is money somebody owes:
// the obligation moves with the key, off the old creator's balance and onto the
// new one. Reset and validity trails hang off key_id and follow on their own.
// One transaction: either the whole account lands, or nothing moves.
// ---------------------------------------------------------------------------
function keyAccount(keyId) {
  // Only the CURRENT OWNER's bills are the key's travelling account. The chain
  // bills above it are those panels' own debts for the sale — they stay with
  // them when the key moves.
  const ownerId = store.scalar('SELECT created_by_id FROM keys WHERE id = ?', [keyId]);
  return {
    bills: Number(store.scalar('SELECT COUNT(*) FROM payments WHERE key_id = ? AND sender_id = ?', [keyId, ownerId])),
    pending: Number(store.scalar(
      `SELECT COALESCE(SUM(amount),0) FROM payments WHERE key_id = ? AND sender_id = ? AND kind = 'due' AND status = 'Pending'`,
      [keyId, ownerId]
    )),
    resets: Number(store.scalar('SELECT COUNT(*) FROM key_resets WHERE key_id = ?', [keyId])),
    validity: Number(store.scalar('SELECT COUNT(*) FROM validity_history WHERE key_id = ?', [keyId]))
  };
}

function transferAccount({ key, target, byUsername }) {
  const oldCreator = users.getById(key.created_by_id);
  const newParent = users.getById(target.parent_id);
  const account = keyAccount(key.id);
  store.transaction(function () {
    keys.transferLineage(key.id, target);
    if (account.bills) {
      store.run('UPDATE payments SET sender_id = ?, receiver_id = ? WHERE key_id = ? AND sender_id = ?',
        [target.id, newParent.id, key.id, oldCreator.id]);
    }
    if (account.pending) {
      users.subDue(oldCreator.id, account.pending);
      users.addDue(target.id, account.pending);
    }
    store.run(
      `INSERT INTO transfer_history
         (key_id, key_name, from_id, from_name, to_id, to_name, username,
          bills_moved, pending_moved, resets_carried, validity_carried)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [key.id, key.key_name, oldCreator.id, oldCreator.username, target.id, target.username,
       String(byUsername || ''), account.bills, account.pending, account.resets, account.validity]
    );
  });
  return account;
}

module.exports = {
  listInSubtree, payUp, accept, acceptAllFrom, recordBy, dueBoard, payersOf,
  billableChildren, chargeKey, openDues, closeOpenDues, keyAccount, transferAccount
};
