'use strict';
// The single access-control rule for the whole app.
// Every list/stat query filters by the requester's subtree, so a tier only ever
// sees itself and the resellers below it. The controller is the root of the tree,
// which is why it sees everything.
const store = require('../../db');
const { CHAIN_COLUMN } = require('../config');

function subtreeIds(rootId) {
  const rows = store.all(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM users WHERE id = ?
       UNION ALL
       SELECT u.id FROM users u JOIN sub s ON u.parent_id = s.id
     )
     SELECT id FROM sub`,
    [rootId]
  );
  return rows.map(r => r.id);
}

// Builds "?,?,?" plus the id array, for use inside a template string.
function inClause(ids) {
  if (!ids.length) return { sql: '(NULL)', params: [] };
  return { sql: ids.map(() => '?').join(','), params: ids };
}

// Ancestor chain for a user, nearest parent first. Used to fill the key lineage.
function ancestors(userId) {
  const out = [];
  let cur = store.get('SELECT id, parent_id, role FROM users WHERE id = ?', [userId]);
  let guard = 0;
  while (cur && cur.parent_id && guard++ < 20) {
    out.push(cur);
    cur = store.get('SELECT id, parent_id, role FROM users WHERE id = ?', [cur.parent_id]);
  }
  return out;
}

// Which existing ancestor holds each role, so a key created deep down can be
// attributed to every tier above it. The column set comes from CHAIN_COLUMN, so
// adding a level to the chain is a config change, not an edit here.
function lineageOf(userId) {
  const columnFor = function (role) { return CHAIN_COLUMN[role] || null; };
  const lineage = {};
  Object.keys(CHAIN_COLUMN).forEach(function (role) { lineage[CHAIN_COLUMN[role]] = null; });

  const chain = ancestors(userId);
  const me = store.get('SELECT role FROM users WHERE id = ?', [userId]);
  if (me) {
    const own = columnFor(me.role);
    if (own) lineage[own] = userId;
  }
  for (const a of chain) {
    const col = columnFor(a.role);
    if (col && !lineage[col]) lineage[col] = a.id;
  }
  return lineage;
}

module.exports = { subtreeIds, inClause, ancestors, lineageOf };
