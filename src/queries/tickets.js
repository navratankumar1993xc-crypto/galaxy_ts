'use strict';
const store = require('../../db');

// /today_result and /top_result both read the current day out of tickets3.
function today() {
  return store.all(
    `SELECT * FROM tickets3 WHERE date(tdate) = date('now','localtime') ORDER BY id DESC`);
}

function todayImages() {
  return store.all(
    `SELECT * FROM tickets3
      WHERE date(tdate) = date('now','localtime') AND img <> '' ORDER BY id DESC`);
}

function countToday() {
  return store.scalar(
    `SELECT COUNT(*) FROM tickets3 WHERE date(tdate) = date('now','localtime')`) || 0;
}

function add(row) {
  store.run(
    `INSERT INTO tickets3 (src, dest, train, pay_mode, mac, key_id, ip, pnr, img, tdate)
     VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, date('now','localtime')))`,
    [row.src || '', row.dest || '', row.train || '', row.pay_mode || '', row.mac || '',
     row.key_id || '', row.ip || '', row.pnr || '', row.img || '', row.tdate || null]
  );
}

module.exports = { today, todayImages, countToday, add };
