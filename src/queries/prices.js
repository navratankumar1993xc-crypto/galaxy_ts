'use strict';
const store = require('../../db');
const { ROLE_ORDER, DEFAULT_SETTINGS } = require('../config');

function priceOf(role) {
  return store.get('SELECT * FROM role_prices WHERE role = ?', [role]) || { role, price: 0, cutoff_hour: 0 };
}

function allPrices() {
  return store.all('SELECT * FROM role_prices ORDER BY role');
}

function savePrice(role, price, cutoffHour) {
  store.run(
    `INSERT INTO role_prices (role, price, cutoff_hour) VALUES (?,?,?)
       ON CONFLICT(role) DO UPDATE SET price = excluded.price, cutoff_hour = excluded.cutoff_hour`,
    [role, Number(price) || 0, Number(cutoffHour) || 0]
  );
}

// 24h hour -> "2:00 AM" style label used on the reference table.
function cutoffLabel(hour) {
  const h = ((Number(hour) || 0) % 24 + 24) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}

function all() {
  const rows = store.all('SELECT key, value FROM settings');
  const out = Object.assign({}, DEFAULT_SETTINGS);
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function set(key, value) {
  store.run(
    `INSERT INTO settings (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

function setBool(key, on) {
  set(key, on ? '1' : '0');
}

// Role pricing plus the daily close schedule, for /set_price's table. Only
// roles that still have a row are listed, because the reference table is the
// price rows themselves and each one carries a delete action.
function priceTable() {
  const rows = store.all('SELECT rowid AS id, role, price, cutoff_hour FROM role_prices');
  const byRole = new Map(rows.map(r => [r.role, r]));
  return ROLE_ORDER
    .filter(role => byRole.has(role))
    .map(role => {
      const row = byRole.get(role);
      return {
        id: row.id,
        role,
        // The reference's table prints the stored role slug with its
        // underscores replaced; the cell's capitalize rule does the rest.
        roleName: role.replace(/_/g, ' '),
        price: row.price,
        cutoffHour: row.cutoff_hour,
        cutoffLabel: cutoffLabel(row.cutoff_hour)
      };
    });
}

function getById(id) {
  return store.get('SELECT rowid AS id, role, price, cutoff_hour FROM role_prices WHERE rowid = ?', [id]);
}

function removePrice(id) {
  store.run('DELETE FROM role_prices WHERE rowid = ?', [id]);
}

module.exports = {
  priceOf, allPrices, savePrice, cutoffLabel, all, set, setBool,
  priceTable, getById, removePrice
};
