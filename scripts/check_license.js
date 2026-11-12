'use strict';
if (!process.env.GALAXY_DB) {
  console.error('Refusing to run against the live database. Use: npm run check');
  process.exit(1);
}

const store = require('../db');
const keys = require('../src/queries/keys');
const base = process.env.GALAXY_BASE || 'http://localhost:3000';
const created = [];
let failures = 0;

function check(name, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  expected=${expected} actual=${actual}`);
}

function authorization(keyName, timestamp = Date.now()) {
  const value = Buffer.from(timestamp + ':' + keyName).toString('base64');
  return 'Basic ' + value;
}

async function validate(keyName, mac, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.authorization !== false) {
    headers.Authorization = authorization(keyName, options.timestamp);
  }
  const response = await fetch(base + '/api/license/validate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ userName: keyName, macAddress: mac, MSG: 'true' })
  });
  return response.json();
}

async function main() {
  const controllerId = store.scalar("SELECT id FROM users WHERE role = 'controller'");
  const owner = { id: controllerId };
  const keyName = 'LICENSECHECK' + Date.now();
  keys.generate({ owner, days: 30, hasPaid: 1, name: keyName });
  const key = keys.getByName(keyName);
  created.push(key.id);

  console.log('\n=== Galaxy license validation');
  const first = await validate(keyName, 'AA:BB:CC:DD:EE:10');
  check('valid key accepted', true, first.success);
  check('normal key type returned', 'normal', first.KeyType);
  check('paid status returned', 'Paid', first.paid);
  check('first valid device is registered', 'AA:BB:CC:DD:EE:10',
    keys.getByName(keyName).mac);

  const sameDevice = await validate(keyName, 'AA:BB:CC:DD:EE:10');
  check('registered device accepted again', true, sameDevice.success);

  const differentDevice = await validate(keyName, 'AA:BB:CC:DD:EE:11');
  check('different device rejected', false, differentDevice.success);

  const missingAuth = await validate(keyName, 'AA:BB:CC:DD:EE:10', { authorization: false });
  check('missing authorization rejected', false, missingAuth.success);

  const staleAuth = await validate(keyName, 'AA:BB:CC:DD:EE:10', {
    timestamp: Date.now() - 10 * 60 * 1000
  });
  check('stale authorization rejected', false, staleAuth.success);

  const unknown = await validate(keyName + 'UNKNOWN', 'AA:BB:CC:DD:EE:12');
  check('unknown key rejected', false, unknown.success);

  store.run("UPDATE keys SET status = 'deactive' WHERE id = ?", [key.id]);
  const inactive = await validate(keyName, 'AA:BB:CC:DD:EE:10');
  check('inactive key rejected', false, inactive.success);

  store.run(
    "UPDATE keys SET status = 'active', expire_date = datetime('now','localtime','-2 days') WHERE id = ?",
    [key.id]
  );
  const expired = await validate(keyName, 'AA:BB:CC:DD:EE:10');
  check('expired key rejected', false, expired.success);

  created.forEach(id => store.run('DELETE FROM keys WHERE id = ?', [id]));
  if (failures) process.exitCode = 1;
}

main().catch(function (err) {
  created.forEach(id => store.run('DELETE FROM keys WHERE id = ?', [id]));
  console.error(err);
  process.exitCode = 1;
});
