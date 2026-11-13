'use strict';
if (!process.env.GALAXY_DB) {
  console.error('Refusing to run against the live database. Use: npm run check');
  process.exit(1);
}

const assert = require('node:assert/strict');
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

  console.log('\n=== Shared sensor delivery');
  const sensorUrl = base + '/api/akamai/sensor/' + encodeURIComponent(keyName);
  const mac = 'AA:BB:CC:DD:EE:10';
  const expectedTokens = ['TEST_APP_SENSOR', 'TEST_BETA_SENSOR', 'TEST_UNTYPED_SENSOR'];
  for (const [index, type] of ['app', 'beta', undefined].entries()) {
    const response = await fetch(sensorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sensors: [expectedTokens[index]], timestamp: Date.now(), userId: keyName, type })
    });
    assert.equal(response.status, 200);
    const posted = await response.json();
    assert.equal(posted.ok, true);
    assert.equal(posted.added, 1);
  }
  const pendingCount = () => store.scalar(
    'SELECT COUNT(*) FROM key_tokens WHERE key_id = ? AND consumed = 0', [key.id]);
  assert.equal(pendingCount(), 3);
  async function deniedSensor(query, expectedMessage) {
    const response = await fetch(sensorUrl + query);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.success, false);
    assert.equal(data.message, expectedMessage);
    assert.deepEqual(data.tokens, []);
    assert.deepEqual(data.sensors, []);
    assert.equal(pendingCount(), 3, 'denied GET must not consume tokens');
    console.log('  ok    ' + expectedMessage + ' (pool unchanged)');
  }
  await deniedSensor('', 'mac_address is required.');
  await deniedSensor('?mac_address=WRONG', 'MAC address does not match this key.');
  store.run("UPDATE keys SET mac = '' WHERE id = ?", [key.id]);
  await deniedSensor('?mac_address=' + encodeURIComponent(mac), 'No MAC address registered for this key.');
  store.run("UPDATE keys SET mac = ?, status = 'deactive' WHERE id = ?", [mac, key.id]);
  await deniedSensor('?mac_address=' + encodeURIComponent(mac), 'Your License is BLOCKED from fetching Tokens.');
  store.run("UPDATE keys SET status = 'active' WHERE id = ?", [key.id]);
  const delivered = await (await fetch(sensorUrl + '?mac_address=' + encodeURIComponent(mac) + '&type=beta')).json();
  assert.equal(delivered.success, true);
  assert.deepEqual(delivered.tokens, expectedTokens);
  assert.deepEqual(delivered.sensors, expectedTokens);
  assert.equal(delivered.userId, keyName);
  assert.equal(typeof delivered.timestamp, 'number');
  assert.equal(pendingCount(), 0);
  const repeated = await (await fetch(sensorUrl + '?mac_address=' + encodeURIComponent(mac))).json();
  assert.equal(repeated.success, true);
  assert.deepEqual(repeated.tokens, []);
  assert.deepEqual(repeated.sensors, []);
  console.log('  ok    matching MAC gets all app/beta/untyped rows once, ignoring type query');

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
