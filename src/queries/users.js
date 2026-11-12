'use strict';
const bcrypt = require('bcryptjs');
const store = require('../../db');
const credentials = require('../credentials');
const { ROLES, ROLE_ORDER } = require('../config');
const { subtreeIds, inClause } = require('./tree');

function listByRole(rootId, role) {
  // Scoped to the requester's subtree, so the controller sees every account of
  // that role anywhere in the tree while a mid tier only sees its own branch.
  const { sql, params } = inClause(subtreeIds(rootId));
  return store.all(
    `SELECT u.id, u.username, u.role, u.parent_id, u.due, u.status, u.closed_at,
            u.created_by, u.created_at, p.username AS parent_name
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
      WHERE u.role = ? AND u.id IN (${sql})
      ORDER BY u.id`,
    [role, ...params]
  );
}

function listAllInSubtree(rootId) {
  // The reference "Total Users" table lists every account in the tree in
  // creation order, the controller row included.
  const ids = subtreeIds(rootId);
  const { sql, params } = inClause(ids);
  return store.all(
    `SELECT u.id, u.username, u.role, u.parent_id, u.due, u.status, u.closed_at,
            u.created_by, u.created_at, p.username AS parent_name
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
      WHERE u.id IN (${sql})
      ORDER BY u.id`,
    params
  );
}

function getById(id) {
  return store.get('SELECT * FROM users WHERE id = ?', [id]);
}

function getPassword(id) {
  const row = store.get('SELECT password_encrypted FROM users WHERE id = ?', [id]);
  return row ? credentials.decrypt(row.password_encrypted) : null;
}

// Case-insensitive name lookup, the same collation the login uses, so a
// controller typing a seller panel's name finds it regardless of case.
function getByUsername(username) {
  return store.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [String(username || '').trim()]);
}

function create({ username, password, role, parentId, createdBy }) {
  // Creating a panel never bills it: every new login starts with due 0. Role
  // prices are used only later, when a parent marks one of its keys Paid.
  const info = store.run(
    `INSERT INTO users (username, password_hash, password_encrypted, role, parent_id, due, status, created_by)
     VALUES (?,?,?,?,?,0, 'active', ?)`,
    [String(username).trim(), bcrypt.hashSync(String(password), 8), credentials.encrypt(password),
      role, parentId, createdBy]
  );
  return Number(info.lastInsertRowid);
}

function setPassword(id, password) {
  store.run(
    'UPDATE users SET password_hash = ?, password_encrypted = ? WHERE id = ?',
    [bcrypt.hashSync(String(password), 8), credentials.encrypt(password), id]
  );
}

function verify(username, password) {
  const user = store.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [String(username).trim()]);
  if (!user) return null;
  return bcrypt.compareSync(String(password), user.password_hash) ? user : null;
}

// Deleting a panel removes its whole downstream tree (ON DELETE CASCADE) and,
// through the same cascade, every key and payment created inside it.
function remove(id) {
  store.run('DELETE FROM users WHERE id = ?', [id]);
}

function setStatus(id, status) {
  // Final Rule: the controller is the highest authority — no login (not even
  // itself) may inactive, disable or block it. Closing it is silently refused
  // here so every code path is covered; reopening anyone is always allowed.
  if (status !== 'active') {
    const target = store.get('SELECT role FROM users WHERE id = ?', [id]);
    if (target && target.role === 'controller') return;
  }
  store.run(
    `UPDATE users SET status = ?, closed_at = ${status === 'closed' ? "datetime('now','localtime')" : 'NULL'} WHERE id = ?`,
    [status, id]
  );
}

function addDue(id, amount) {
  // Final Rule: the controller sits above every panel and owes nothing — a Due
  // is never created on it. Bills only ever land on the tiers below it.
  const target = store.get('SELECT role FROM users WHERE id = ?', [id]);
  if (target && target.role === 'controller') return;
  store.run('UPDATE users SET due = due + ? WHERE id = ?', [Number(amount), id]);
}

function subDue(id, amount) {
  store.run('UPDATE users SET due = MAX(due - ?, 0) WHERE id = ?', [Number(amount), id]);
}

function descendantIds(rootId) {
  return subtreeIds(rootId).filter(id => id !== rootId);
}

function childRolesOf(role) {
  return ROLE_ORDER.slice(ROLE_ORDER.indexOf(role) + 1);
}

module.exports = {
  listByRole, listAllInSubtree, getById, getPassword, getByUsername, create, setPassword, verify, remove,
  setStatus, addDue, subDue, descendantIds, childRolesOf, roleLabel: r => (ROLES[r] || {}).label || r
};
