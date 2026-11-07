'use strict';
const prices = require('../../src/queries/prices');
const keys = require('../../src/queries/keys');
const news = require('../../src/queries/news');
const tickets = require('../../src/queries/tickets');
const { TILES } = require('../../src/menu');

// Dashboard: the 8 gradient tiles plus the news box, identical markup for every
// tier; only the subtree behind the counts changes.
function home(req, res) {
  const me = res.locals.me;
  const tiles = TILES;
  const counts = keys.counts(me.id);

  res.render('tiers/home', {
    tiles,
    counts,
    newsItem: news.latestFor(me.role),
    // Today's ticket count is controller-level data in the reference build.
    todayResults: me.role === 'controller' ? tickets.countToday() : 0
  });
}

// Sidebar "Allow demo key" switch. The reference markup posts the field twice —
// a hidden allow_demo=0 plus the checkbox's allow_demo=1 — and PHP keeps the
// *last* value, which is why it works there. Express instead folds duplicate
// keys into an array, so ["0","1"] stringified becomes "0,1" and a naive
// === '1' test can never turn the switch on. Same markup, PHP's last-value rule.
function lastValue(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function toggleDemo(req, res) {
  const wanted = String(lastValue(req.body.allow_demo)) === '1';
  const asked = parseInt(req.body.days, 10);
  const daysOk = Number.isInteger(asked) && asked >= 1 && asked <= 3650;
  const stored = parseInt(prices.all().demo_days, 10);
  const length = Number.isInteger(stored) && stored >= 1 ? stored : 2;

  // Turning demo ON is the controller committing to a length, so the switch only
  // sticks when a usable number arrives with it — the sidebar asks for the days
  // first and the server refuses the same way, so a hand-made POST cannot skip
  // the question. Switching OFF never needs a number.
  if (wanted && !daysOk) {
    req.session.flash = [{
      type: 'warning',
      text: prices.all().allow_demo === '1'
        ? 'Demo stays enabled at ' + length + ' days — type a number between 1 and 3650 to change it.'
        : 'Choose the demo days first — the switch turns on with the number you type.'
    }];
    res.redirect(req.get('referer') || '/home');
    return;
  }

  prices.setBool('allow_demo', wanted);
  if (daysOk) prices.set('demo_days', String(asked));
  const now = parseInt(prices.all().demo_days, 10);

  req.session.flash = [{
    type: 'success',
    text: 'Demo keys are ' + (wanted ? 'enabled' : 'disabled') +
      ' — website demo is ' + (Number.isInteger(now) && now >= 1 ? now : length) + ' days.'
  }];
  res.redirect(req.get('referer') || '/home');
}

module.exports = { home, toggleDemo };
