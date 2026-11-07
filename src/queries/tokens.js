'use strict';
const store = require('../../db');
const { subtreeIds, inClause } = require('./tree');
const { dateLabel } = require('../config');

function record({ userId, label, sensors = 0, status = 'valid' }) {
  store.run(
    `INSERT INTO tokens (user_id, user_label, sensors, status, ts)
     VALUES (?,?,?,?, datetime('now','localtime'))`,
    [userId, label, Number(sensors) || 0, status]
  );
}

function scoped(rootId) {
  const ids = subtreeIds(rootId).filter(id => id !== rootId);
  if (!ids.length) return null;
  return inClause(ids);
}

// The three counters across the top of /token_stats.
function summary(rootId) {
  const sc = scoped(rootId);
  const where = sc ? `WHERE user_id IN (${sc.sql})` : "WHERE 1 = 0";
  const args = sc ? sc.params : [];
  return {
    today: store.scalar(
      `SELECT COUNT(*) FROM tokens ${where}
        AND date(ts) = date('now','localtime')`, args) || 0,
    thisHour: store.scalar(
      `SELECT COUNT(*) FROM tokens ${where}
        AND strftime('%Y-%m-%d %H', ts) = strftime('%Y-%m-%d %H', 'now','localtime')`, args) || 0,
    allTime: store.scalar(`SELECT COUNT(*) FROM tokens ${where}`, args) || 0
  };
}

// Day-by-day counts for the last 7 days, oldest first, for the chart.
function lastSevenDays(rootId) {
  const sc = scoped(rootId);
  const where = sc ? `AND user_id IN (${sc.sql})` : 'AND 1 = 0';
  const args = sc ? sc.params : [];
  const rows = store.all(
    `SELECT date(ts) AS day, COUNT(*) AS n FROM tokens
      WHERE date(ts) >= date('now','localtime','-6 days') ${where}
      GROUP BY day`, args);
  const byDay = new Map(rows.map(r => [r.day, r.n]));
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const day = store.scalar(`SELECT date('now','localtime', ?)`, [`-${i} days`]);
    out.push({ day, label: dateLabel(day, false), n: byDay.get(day) || 0 });
  }
  return out;
}

function topUsersToday(rootId) {
  const sc = scoped(rootId);
  const where = sc ? `WHERE user_id IN (${sc.sql}) AND` : 'WHERE';
  const args = sc ? sc.params : [];
  return store.all(
    `SELECT COALESCE(u.username, t.user_label) AS user, COUNT(*) AS tokens
       FROM tokens t LEFT JOIN users u ON u.id = t.user_id
      ${where} date(t.ts) = date('now','localtime')
      GROUP BY user ORDER BY tokens DESC LIMIT 10`, args);
}

function recent(rootId, limit = 50) {
  const sc = scoped(rootId);
  const where = sc ? `WHERE t.user_id IN (${sc.sql})` : 'WHERE 1 = 0';
  const args = sc ? sc.params : [];
  return store.all(
    `SELECT t.*, COALESCE(u.username, t.user_label) AS user_label
       FROM tokens t LEFT JOIN users u ON u.id = t.user_id
      ${where} ORDER BY t.id DESC LIMIT ${Number(limit)}`, args);
}

module.exports = { record, summary, lastSevenDays, topUsersToday, recent };
