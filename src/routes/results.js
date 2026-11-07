'use strict';
const tickets = require('../queries/tickets');

// ------------------------------------------------------------ /today_result
function todayResult(req, res) {
  res.render('controller/today_result', { rows: tickets.today() });
}

// -------------------------------------------------------------- /top_result
function topResult(req, res) {
  res.render('controller/top_result', { images: tickets.todayImages() });
}

module.exports = { todayResult, topResult };
