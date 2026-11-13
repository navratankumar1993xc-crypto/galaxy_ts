'use strict';
const store = require('../../db');

// Push one or more tokens into a key's pool. Returns how many were stored.
function add(keyId, type, tokenList) {
  let n = 0;
  store.transaction(function () {
    for (const raw of tokenList) {
      const token = String(raw == null ? '' : raw).trim();
      if (!token) continue;
      store.run(
        `INSERT INTO key_tokens (key_id, type, token) VALUES (?,?,?)`,
        [keyId, type, token]
      );
      n++;
    }
  });
  return n;
}

// Tokens still waiting to be handed to the software, oldest first.
function pending(keyId) {
  return store.all(
    `SELECT id, token FROM key_tokens
      WHERE key_id = ? AND consumed = 0
      ORDER BY id`,
    [keyId]
  );
}

// Mark a set of rows delivered so the next GET does not repeat them.
function consume(ids) {
  if (!ids.length) return;
  store.transaction(function () {
    for (const id of ids) {
      store.run(
        `UPDATE key_tokens SET consumed = 1, consumed_at = datetime('now','localtime')
          WHERE id = ?`,
        [id]
      );
    }
  });
}

// Per-key pending counts for the controller table: { key_id, key_name, app, beta }.
function pendingByRoot(rootId) {
  const { subtreeIds, inClause } = require('./tree');
  const ids = subtreeIds(rootId);
  if (!ids.length) return [];
  const sc = inClause(ids);
  return store.all(
    `SELECT k.id AS key_id, k.key_name,
            SUM(CASE WHEN t.type = 'app'  AND t.consumed = 0 THEN 1 ELSE 0 END) AS app,
            SUM(CASE WHEN t.type = 'beta' AND t.consumed = 0 THEN 1 ELSE 0 END) AS beta
       FROM keys k
       LEFT JOIN key_tokens t ON t.key_id = k.id
      WHERE k.created_by_id IN (${sc.sql})
      GROUP BY k.id
      ORDER BY k.id DESC`,
    sc.params
  );
}

module.exports = { add, pending, consume, pendingByRoot };