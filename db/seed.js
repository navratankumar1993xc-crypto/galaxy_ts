'use strict';
// Creates the controller account, the default role pricing table, and settings.
// With --demo it also builds one full reseller chain so every tier can be
// logged into locally; that demo branch is clearly separate and only runs when
// the users table is still empty.
const bcrypt = require('bcryptjs');
const store = require('./index');
const { ROLE_ORDER, DEFAULT_SETTINGS, DEFAULT_ROLE_PRICES } = require('../src/config');

function bootstrap() {
  for (const [role, cfg] of Object.entries(DEFAULT_ROLE_PRICES)) {
    store.run(
      `INSERT INTO role_prices (role, price, cutoff_hour) VALUES (?,?,?)
         ON CONFLICT(role) DO UPDATE SET price = excluded.price, cutoff_hour = excluded.cutoff_hour`,
      [role, cfg.price, cfg.cutoff_hour]
    );
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    store.run(
      `INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO NOTHING`, [key, value]
    );
  }

  const existing = store.scalar(`SELECT id FROM users WHERE role = 'controller' LIMIT 1`);
  if (existing) {
    console.log('Controller already present — skipping account creation.');
    return;
  }
  store.run(
    `INSERT INTO users (username, password_hash, role, parent_id, due, status, created_by)
     VALUES (?,?, 'controller', NULL, 0, 'active', 'admin')`,
    ['admin', bcrypt.hashSync('admin123', 8)]
  );
  console.log('Controller created  ->  admin / admin123');
}

// One account per tier, chained parent-to-child, plus a few keys and a payment
// so the dashboard tiles and the money pages have something to show.
function demo() {
  if (store.scalar('SELECT COUNT(*) FROM users') > 1) {
    console.log('Users already exist — skipping demo data.');
    return;
  }

  const chain = [
    ['LUCKYDEV', 'developer'],
    ['LUCKYSUPERMASTER', 'super_master_admin'],
    ['YOGIMASTER', 'master_admin'],
    ['YOGIADMIN', 'admin'],
    ['YOGISUPERSELLER', 'super_seller'],
    ['YOGISELL', 'seller']
  ];
  let parentId = store.scalar(`SELECT id FROM users WHERE role = 'controller' LIMIT 1`);
  let createdBy = 'admin';
  const made = [];

  for (const [username, role] of chain) {
    // Creating a panel never bills it — every login starts with due 0.
    const info = store.run(
      `INSERT INTO users (username, password_hash, role, parent_id, due, status, created_by)
       VALUES (?,?,?, ?,0,'active', ?)`,
      [username, bcrypt.hashSync('demo123', 8), role, parentId, createdBy]
    );
    parentId = Number(info.lastInsertRowid);
    createdBy = username;
    made.push({ username, role, id: parentId });
  }

  const seller = made[made.length - 1];
  // Payments always go to the payer's own parent, so the receiver is read off
  // the chain instead of a fixed index — the chain has an extra level now.
  const sellerParent = made[made.length - 2];
  const keys = require('../src/queries/keys');
  const owner = { id: seller.id };
  // One controller-level demo key too, because that is the only level a demo can
  // be started at: its lineage cells stay empty and it appears just in the
  // controller's own list. It keeps a random name on purpose — the numbered
  // DEMO01, DEMO02... keys belong to the website, and the first public click
  // should produce DEMO01 rather than DEMO02.
  const controllerId = store.scalar(`SELECT id FROM users WHERE role = 'controller' LIMIT 1`);
  const keyNames = [
    keys.generate({ owner, days: 30, type: 'normal', hasPaid: 1, mac: 'AA:BB:CC:DD:EE:01' }),
    keys.generate({ owner, days: 7,  type: 'normal', hasPaid: 1, mac: '' }),
    keys.generate({ owner, days: 1,  type: 'normal', hasPaid: 0, mac: '' }),
    keys.generate({ owner: { id: controllerId }, days: 2, type: 'demo', hasPaid: 1, mac: '' })
  ];

  const payments = require('../src/queries/payments');
  // The demo seller's due comes from a key bill, not from being created: raise
  // it the way markPaid would, then let the recorded payment settle it back to 0.
  require('../src/queries/users').addDue(seller.id, DEFAULT_ROLE_PRICES.seller.price);
  payments.recordBy(sellerParent.id, seller.id, DEFAULT_ROLE_PRICES.seller.price);

  // The reference ships one broadcast per panel, all the same message; only the
  // team name is ours. The line breaks are \r\n because that is what the
  // reference stores.
  const news = require('../src/queries/news');
  const BROADCAST =
    '\u{1F6A8} *GALAXY TATKAL BOOKING \u2013 LATEST UPDATE* \u{1F6A8}\r\n\r\n' +
    '\u2705 *WEB | WEB2 | WEB3 | APP LOGIN* \u2013 All Working\r\n\r\n' +
    '\u{1F4B3} *Payment Modes*\r\n' +
    '* UPI Manual Payment Supported\r\n' +
    '* iPay QR Manual Payment Supported\r\n\r\n' +
    '\u{1F310} *Important Instructions*\r\n' +
    '* Web use karne se pehle *IP Fix* zarur karein.\r\n' +
    '* Manual Login tak software ke diye gaye instructions ko follow karein.\r\n' +
    '* App Login ke liye *Token* pehle generate karna zaruri hai.\r\n\r\n' +
    '\u{1F3AF} *Tatkal Booking \u2013 100% Ready*\r\n' +
    'Software ke instructions ko step-by-step follow karke best booking experience paayein.\r\n\r\n' +
    '\u{1F525} *TEAM GALAXY*';
  // Every tier below the controller gets the broadcast, plus the app-news row,
  // in ROLE_ORDER so the list still matches the /news dropdown by itself.
  ROLE_ORDER.filter(role => role !== 'controller').concat('appnews')
    .forEach(function (target) { news.send(BROADCAST, target, 'admin'); });

  console.log('Demo chain created:');
  for (const m of made) console.log(`  ${m.username.padEnd(18)} ${m.role.padEnd(20)} demo123`);

  // ---------------------------------------------------------------- demo feeds
  // tickets3 and tokens are filled by the client software in the real system,
  // and there is no upstream here, so these rows are sample data. They exist
  // so /today_result, /top_result and /token_stats render their real shapes.
  const tickets = require('../src/queries/tickets');
  [
    ['NDLS', 'JP',    '12494', 'UPI',  'AA:BB:CC:DD:EE:01', keyNames[0], '103.42.17.9',   'MZ48219076'],
    ['ADT',  'MAS',   '22603', 'WALLET', '',                keyNames[1], '49.36.118.204', 'HJ77340192'],
    ['CSMT', 'ADI',   '12981', 'CARD', '',                  keyNames[2], '27.61.93.15',   'QP11057388']
  ].forEach(function (r) {
    tickets.add({
      src: r[0], dest: r[1], train: r[2], pay_mode: r[3], mac: r[4],
      key_id: r[5], ip: r[6], pnr: r[7], img: ''
    });
  });
  // No image column values, so /top_result keeps the reference's empty state.

  // A handful of tokens per day for the last week, all from the one MAC that
  // is registered, so the chart and the counters have something to show.
  const countsByDay = [3, 0, 5, 2, 7, 4, 11];
  countsByDay.forEach(function (n, i) {
    const back = countsByDay.length - 1 - i;
    for (let s = 0; s < n; s++) {
      store.run(
        `INSERT INTO tokens (user_id, user_label, sensors, status, ts, received_at)
         VALUES (?,?,?,?,
                 datetime('now','localtime','-' || ? || ' days', '+' || ? || ' minutes'),
                 datetime('now','localtime','-' || ? || ' days', '+' || ? || ' minutes'))`,
        [made[0].id, keyNames[0], (s % 4) + 1, 'valid', back, s * 7, back, s * 7]
      );
    }
  });
  console.log('Sample tickets and token history added (no upstream feed locally).');
}

// `npm run db:seed` / `db:demo` run this file directly; server.js requires it
// to bootstrap an empty database on first start.
if (require.main === module) {
  const which = process.argv.slice(2);
  bootstrap();
  if (which.includes('--demo')) demo();
  console.log('Done.');
}

module.exports = { bootstrap, demo };
