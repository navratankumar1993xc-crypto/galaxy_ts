'use strict';
const store = require('../../db');
const keys = require('../queries/keys');
const { dateLabel } = require('../config');

function isoDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    ? String(value)
    : store.scalar(`SELECT date('now','localtime')`);
}

// The reference prints the range as "07 Nov 2026" and defaults both inputs to
// today, so opening the page reports the current day.
function page(req, res) {
  const me = res.locals.me;
  const fromDate = isoDay(req.query.from_date);
  const toDate = isoDay(req.query.to_date);

  // SQLite date() comparison is inclusive, but a reversed range would just be
  // empty; swapping keeps the page useful instead of blank.
  const from = fromDate <= toDate ? fromDate : toDate;
  const to = fromDate <= toDate ? toDate : fromDate;

  const rows = keys.inRange(me.id, from, to);
  res.render('tiers/reports', {
    fromDate: from,
    toDate: to,
    fromLabel: dateLabel(from),
    toLabel: dateLabel(to),
    summary: {
      total: rows.length,
      paid: rows.filter(k => k.has_paid).length,
      unpaid: rows.filter(k => !k.has_paid).length
    },
    rows
  });
}

module.exports = { page };
