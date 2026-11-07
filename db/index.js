'use strict';
// SQLite access via the built-in node:sqlite module (Node >= 22).
// Chosen over better-sqlite3 so the project needs no native compilation.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ROOT, DB_FILE } = require('../src/config');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

// CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it was, so the
// Super Seller tier needs its own pass. It runs first because schema.sql also
// indexes the new column, which an old database does not have yet. On a fresh
// database migrate finds no tables and does nothing.
const upgraded = require('./migrate').upgrade(db);
if (upgraded.length) console.log('Schema upgraded -> ' + upgraded.join(', ') + '.');

db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));

// node:sqlite returns null-prototype objects; convert so EJS / JSON behave.
function plain(row) {
  return row ? Object.assign({}, row) : row;
}

module.exports = {
  db,
  all(sql, params = []) {
    return db.prepare(sql).all(...params).map(plain);
  },
  get(sql, params = []) {
    return plain(db.prepare(sql).get(...params));
  },
  run(sql, params = []) {
    return db.prepare(sql).run(...params);
  },
  scalar(sql, params = []) {
    const row = plain(db.prepare(sql).get(...params));
    if (!row) return null;
    const key = Object.keys(row)[0];
    return key === undefined ? null : row[key];
  },
  transaction(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
};
