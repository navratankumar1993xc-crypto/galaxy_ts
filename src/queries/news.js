'use strict';
const store = require('../../db');
const { ROLE_ORDER, ROLES } = require('../config');
const { inClause } = require('./tree');

// target_role is one of the /news dropdown values, including the special
// 'appnews' row that the reference sends to the mobile app rather than a tier.
// Both lists follow ROLE_ORDER, so a tier added to the chain lands in the
// dropdown, the labels and the visibility rules by itself.
const TIERS = ROLE_ORDER.filter(role => role !== 'controller');
const TARGETS = TIERS.concat('appnews');

const TARGET_LABEL = TIERS.reduce(function (out, role) {
  out[role] = ROLES[role].label;
  return out;
}, { appnews: 'App News' });

function send(body, targetRole, createdBy) {
  store.run('INSERT INTO news (body, target_role, created_by) VALUES (?,?,?)',
    [String(body).trim(), targetRole, createdBy]);
}

function listAll() {
  return store.all('SELECT * FROM news ORDER BY id DESC');
}

function getById(id) {
  return store.get('SELECT * FROM news WHERE id = ?', [id]);
}

// Roles a viewer may address from the /news compose box. A tier can only
// broadcast down its own branch, and 'appnews' (the mobile feed) is a
// controller-only option; a seller has nobody below it, so it gets nothing.
function targetsFor(role) {
  const at = ROLE_ORDER.indexOf(role);
  if (at < 0) return [];
  return TARGETS
    .filter(t => t === 'appnews' ? role === 'controller' : ROLE_ORDER.indexOf(t) > at)
    .map(t => ({ value: t, label: TARGET_LABEL[t] }));
}

// The list under the compose box: broadcasts aimed at this tier or at anyone
// below it, plus everything this account sent itself.
function listScoped(role, username) {
  const at = ROLE_ORDER.indexOf(role);
  const visible = TARGETS.filter(t =>
    t === 'appnews' ? role === 'controller' : ROLE_ORDER.indexOf(t) >= at);
  const { sql, params } = inClause(visible);
  return store.all(
    `SELECT * FROM news WHERE (target_role IN (${sql}) OR created_by = ?)
      ORDER BY id DESC`,
    [...params, username]
  );
}

function listFor(role) {
  // A tier sees news addressed to it plus anything aimed at the app as a whole.
  const rows = store.all(
    `SELECT * FROM news WHERE target_role IN (?, 'appnews') ORDER BY id DESC`,
    [role]
  );
  return rows;
}

function latestFor(role) {
  // One rule for every tier, controller included: the dashboard box shows the
  // newest broadcast addressed to *this* role. 'appnews' is the mobile app's own
  // feed and is deliberately not panel news, and nothing in the /news dropdown
  // can be addressed to the controller -- which is exactly why the reference's
  // controller dashboard reads "No news for now." with six broadcasts live.
  return store.get(
    `SELECT * FROM news WHERE target_role = ? ORDER BY id DESC LIMIT 1`,
    [role]
  );
}

function remove(id) {
  store.run('DELETE FROM news WHERE id = ?', [id]);
}

module.exports = {
  TARGETS, TARGET_LABEL, send, listAll, getById, targetsFor, listScoped,
  listFor, latestFor, remove
};
