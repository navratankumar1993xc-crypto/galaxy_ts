'use strict';
const store = require('../../db');
const { indiaDate } = require('../resultValidation');

// New timestamps are India booking dates, independent of the server timezone.
// Legacy inserts retain their historical local-date defaults and query behavior.
const TODAY = `((upload_identity IS NOT NULL AND tdate = ?) OR
  (upload_identity IS NULL AND date(tdate) = date('now','localtime')))`;
function today() {
  return store.all(`SELECT * FROM tickets3 WHERE ${TODAY} ORDER BY id DESC`, [indiaDate()]);
}
function todayImages() {
  return store.all(`SELECT * FROM tickets3 WHERE ${TODAY}
    AND (img <> '' OR image_file IS NOT NULL) ORDER BY id DESC`, [indiaDate()]);
}
function countToday() {
  return store.scalar(`SELECT COUNT(*) FROM tickets3 WHERE ${TODAY}`, [indiaDate()]) || 0;
}
function add(row) {
  store.run(
    `INSERT INTO tickets3 (src, dest, train, pay_mode, mac, key_id, ip, pnr, img, tdate)
     VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, date('now','localtime')))`,
    [row.src || '', row.dest || '', row.train || '', row.pay_mode || '', row.mac || '',
     row.key_id || '', row.ip || '', row.pnr || '', row.img || '', row.tdate || null]
  );
}
function get(id) { return store.get('SELECT * FROM tickets3 WHERE id = ?', [id]); }
function byIdentity(identity) { return store.get('SELECT id FROM tickets3 WHERE upload_identity = ?', [identity]); }
function addResult(row) {
  const columns = ['src', 'dest', 'train', 'pay_mode', 'mac', 'key_id', 'ip', 'pnr', 'tdate',
    'upload_identity', 'result_id', 'booking_time', 'uploaded_at', 'evidence', 'connection_kind',
    'proxy_encrypted', 'observed_ip', 'ip_observed_at', 'ip_source', 'image_file', 'image_mime'];
  return Number(store.run(`INSERT INTO tickets3 (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    columns.map(column => row[column])).lastInsertRowid);
}
module.exports = { today, todayImages, countToday, add, get, byIdentity, addResult };
