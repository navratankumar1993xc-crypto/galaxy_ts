'use strict';
const store = require('../../db');
const { ROLE_ORDER, ROLES } = require('../config');
const { inClause } = require('./tree');

// target_role is one of the /news dropdown values, including global broadcasts.
const TIERS = ROLE_ORDER.filter(role => role !== 'controller');
const TARGETS = TIERS.concat('appnews', 'allpanels', 'personal');

const TARGET_LABEL = TIERS.reduce(function (out, role) {
  out[role] = ROLES[role].label;
  return out;
}, { appnews: 'App News', allpanels: 'All Panels', personal: 'Personal' });

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
// broadcast down its own branch; App News and All Panels are controller-only.
// Personal broadcasts are available to every panel level.
function targetsFor(role) {
  const at = ROLE_ORDER.indexOf(role);
  if (at < 0) return [];
  return TARGETS
    .filter(t => {
      if (t === 'personal') return true;
      if (t === 'appnews' || t === 'allpanels') return role === 'controller';
      return ROLE_ORDER.indexOf(t) > at;
    })
    .map(t => ({ value: t, label: TARGET_LABEL[t] }));
}

// The list under the compose box: broadcasts aimed at this tier or at anyone
// below it, plus everything this account sent itself.
function listScoped(role, username) {
  const at = ROLE_ORDER.indexOf(role);
  const visible = TARGETS.filter(t => t === 'allpanels' || t === 'personal' ||
    (t === 'appnews' ? role === 'controller' : ROLE_ORDER.indexOf(t) >= at));
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
  // The dashboard box shows the newest broadcast addressed to this role or
  // sent to all panels. App News is a separate feed, not panel dashboard news.
  return store.get(
    `SELECT * FROM news WHERE target_role IN (?, 'allpanels', 'personal') ORDER BY id DESC LIMIT 1`,
    [role]
  );
}

function latestTickerFor(role) {
  return store.get(
    `SELECT * FROM news WHERE target_role IN (?, 'appnews', 'allpanels', 'personal') ORDER BY id DESC LIMIT 1`,
    [role]
  );
}

function remove(id) {
  store.run('DELETE FROM news WHERE id = ?', [id]);
}

module.exports = {
  TARGETS, TARGET_LABEL, send, listAll, getById, targetsFor, listScoped,
  listFor, latestFor, latestTickerFor, remove
};
