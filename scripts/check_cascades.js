'use strict';
// Plan step 8: the two cascade rules that keys.enforceCascades() applies on
// every page load. Test rows go straight into the shared SQLite file and are
// removed again, so the demo data ends untouched.
const path = require('path');
const fs = require('fs');
const store = require('../db');

const T = process.env.TEMP || process.env.TMP || '/tmp';
const B = 'http://localhost:3000';
const { execFileSync } = require('child_process');
const { CHAIN_TIERS } = require('../src/config');

// The chain columns are copied from a real key, listed through CHAIN_TIERS so
// the insert keeps up with the tier table in src/config.js.
const CHAIN_COLS = CHAIN_TIERS.map(function (tier) { return tier.column; });

const SELLER = store.get(`SELECT * FROM users WHERE username = 'YOGISELL'`);
const template = SELLER && store.get(`SELECT * FROM keys WHERE created_by_id = ? LIMIT 1`, [SELLER.id]);
if (!SELLER || !template) {
  console.log('FAIL  need the demo seller and one of its keys to build the test rows');
  process.exit(1);
}
// The due the seller really has, put back by the cleanup below: rule B needs it
// to be non-zero while it runs, and nothing here should spend the owner's money.
const originalDue = Number(SELLER.due);

const grace = {
  key: Number(store.scalar(`SELECT value FROM settings WHERE key = 'key_grace_hours'`)),
  child: Number(store.scalar(`SELECT value FROM settings WHERE key = 'child_grace_hours'`))
};
console.log('settings: key_grace_hours=' + grace.key + ', child_grace_hours=' + grace.child);

// ageDays is the age of both start and expiry; a negative value puts them in
// the future, which is how the "still alive" rows get their remaining days. The
// whole offset goes to SQLite as one string ('-72 days', '+1 days') because
// building it out of a '-' literal and a negative number would read '--1 days'.
function putKey(name, ageDays, hasPaid, status, days = 30) {
  const when = (ageDays < 0 ? '+' : '-') + Math.abs(ageDays) + ' days';
  store.run(
    `INSERT INTO keys (key_name, mac, ips, ${CHAIN_COLS.join(', ')},
                       created_by_id, days, start_date, expire_date, has_paid, type, status)
     VALUES (?, '', '', ${CHAIN_COLS.map(() => '?').join(', ')}, ?, ?,
             datetime('now','localtime', ?),
             datetime('now','localtime', ?), ?, 'normal', ?)`,
    [name, ...CHAIN_COLS.map(c => template[c]), SELLER.id, days, when, when, hasPaid, status]
  );
}

const statusOf = name => store.scalar(`SELECT status FROM keys WHERE key_name = ?`, [name]);

// One authenticated page hit is enough: enforceRules() runs the cascades for the
// whole database, whoever makes the request. The session cookie is made here
// instead of borrowed from another script's jar, because the session store lives
// in memory and does not survive a restart — and an unauthenticated hit silently
// skips the very rule being tested.
//
// It signs in as the panel ABOVE the seller, not as the seller itself: rule B
// closes the seller's panel, and a closed panel is refused at /login, so the
// victim cannot be the witness. The hit is verified, because curl without -L
// writes an empty file for the 302 back to /login, which would otherwise read as
// a clean page while nothing at all was cascaded.
const JAR = path.join(T, 'j_cascade.txt');
const OUT = path.join(T, 'cascade.html');
const INVISIBLE = path.join(T, 'cascade_login_response.html');
const WATCHER = { username: 'YOGIMASTER', password: 'demo123' };
function touch() {
  const redir = execFileSync('curl', ['-s', '-c', JAR, '-o', INVISIBLE, '-w', '%{redirect_url}',
    '-X', 'POST', '-d', 'username=' + WATCHER.username + '&password=' + WATCHER.password, B + '/login'],
    { encoding: 'utf8' });
  execFileSync('curl', ['-s', '-b', JAR, '-o', OUT, B + '/home']);
  const html = fs.readFileSync(OUT, 'utf8');
  const signedIn = /\/home/.test(redir) && !/action="\/login"/.test(html) && /logout|Logout/.test(html);
  if (!signedIn) {
    console.log('FAIL  ' + WATCHER.username + ' could not sign in to run the cascades (redirect=' + JSON.stringify(redir) + ')');
    process.exit(1);
  }
}

let failures = 0;
function check(label, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + '  expected=' + expected + ' actual=' + actual);
}

try {
  // --- rule A: an unpaid key stays alive for key_grace_hours past expiry, then dies
  putKey('CASCADE_UNPAID_OLD', grace.key + 24, 0, 'active');   // expired beyond grace
  putKey('CASCADE_UNPAID_NEW', 1, 0, 'active');                // expired inside grace
  putKey('CASCADE_PAID_OLD', grace.key + 24, 1, 'active');     // paid: grace does not apply
  touch();

  console.log('\nrule A - unpaid expired keys (grace ' + grace.key + 'h)');
  check('CASCADE_UNPAID_OLD (expired ' + (grace.key + 24) + 'h ago)', 'deactive', statusOf('CASCADE_UNPAID_OLD'));
  check('CASCADE_UNPAID_NEW (expired 1h ago, still inside grace)', 'active', statusOf('CASCADE_UNPAID_NEW'));
  check('CASCADE_PAID_OLD (paid, so grace never fires)', 'active', statusOf('CASCADE_PAID_OLD'));

  store.run(`DELETE FROM keys WHERE key_name LIKE 'CASCADE_UNPAID%' OR key_name = 'CASCADE_PAID_OLD'`);

  // --- rule B: a closed panel's children survive child_grace_hours, then stop
  // The panel reopens itself the moment its due is zero (that is auth.enforceRules),
  // so a test that wants it to stay closed has to leave it something to owe.
  const oweSomething = () => store.run(`UPDATE users SET due = MAX(due, 1) WHERE id = ?`, [SELLER.id]);
  const closePanel = hoursAgo => {
    store.run(`UPDATE users SET status = 'closed', closed_at = datetime('now','localtime','-' || ? || ' hours') WHERE id = ?`,
      [hoursAgo, SELLER.id]);
    oweSomething();
  };
  putKey('CASCADE_CLOSED', 1, 1, 'active');
  closePanel(grace.child - 5);
  touch();
  console.log('\nrule B - closed panel, ' + (grace.child - 5) + 'h ago (grace ' + grace.child + 'h)');
  check('CASCADE_CLOSED still alive inside the child grace', 'active', statusOf('CASCADE_CLOSED'));

  closePanel(grace.child + 10);
  touch();
  check('same key after the child grace passed', 'deactive', statusOf('CASCADE_CLOSED'));

  // An active panel's paid key must not be swept up by the rule.
  putKey('CASCADE_ACTIVE', -1, 1, 'active', 1);
  store.run(`UPDATE users SET status = 'active', closed_at = NULL WHERE id = ?`, [SELLER.id]);
  touch();
  console.log('\nrule B - reopened panel');
  check('CASCADE_ACTIVE paid key stays active', 'active', statusOf('CASCADE_ACTIVE'));
} finally {
  store.run(`DELETE FROM keys WHERE key_name LIKE 'CASCADE_%'`);
  store.run(`UPDATE users SET status = 'active', closed_at = NULL, due = ? WHERE id = ?`, [originalDue, SELLER.id]);
  console.log('\ncleanup: test keys removed, ' + SELLER.username + ' restored to active with its own due');
  console.log('leftover CASCADE rows: ' + store.scalar(`SELECT COUNT(*) FROM keys WHERE key_name LIKE 'CASCADE_%'`));
}

console.log('cascade failures: ' + failures);
process.exit(failures ? 1 : 0);
