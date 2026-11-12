'use strict';
if (!process.env.GALAXY_DB) {
  console.error('Refusing to run against the live database. Use: npm run check');
  process.exit(1);
}

const bcrypt = require('bcryptjs');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const store = require('../db');
const users = require('../src/queries/users');
const keys = require('../src/queries/keys');
const prices = require('../src/queries/prices');
const { ROLES } = require('../src/config');

const BASE = process.env.GALAXY_BASE || 'http://localhost:3000';
const TEMP = process.env.TEMP || os.tmpdir();
const PASSWORD = 'SuccessCheck123!';
let failures = 0;
let requestNo = 0;
const cookieJars = [];

function check(name, expected, actual) {
  const ok = String(expected) === String(actual);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  expected=${expected} actual=${actual}`);
}

function request(url, fields, jar, follow) {
  const output = path.join(TEMP, 'success_details_' + process.pid + '_' + (++requestNo) + '.html');
  const args = ['-sS', '-o', output, '-w', '%{http_code}'];
  if (jar) args.push('-b', jar, '-c', jar);
  if (follow) args.push('-L');
  Object.keys(fields || {}).forEach(function (name) {
    args.push('--data-urlencode', name + '=' + fields[name]);
  });
  const status = Number(execFileSync('curl', args.concat(BASE + url), { encoding: 'utf8' }).trim());
  const body = fs.readFileSync(output, 'utf8');
  fs.unlinkSync(output);
  return { status, body };
}

function login(username, password) {
  const jar = path.join(TEMP, 'success_details_' + process.pid + '_' + username + '.cookies');
  cookieJars.push(jar);
  const result = request('/login', { username, password }, jar, true);
  if (result.status !== 200) throw new Error('Could not log in as ' + username + ': ' + result.status);
  return jar;
}

const tiers = [
  ['developer', 'SUCCESSDEV'],
  ['super_master_admin', 'SUCCESSMASTER'],
  ['master_admin', 'SUCCESSADMIN'],
  ['admin', 'SUCCESSSUPERSELLER'],
  ['super_seller', 'SUCCESSELLER'],
  ['seller', 'SUCCESSCUSTOMER']
];
const previousSetupLink = prices.all().setup_link;

console.log('\n=== existing databases gain encrypted-credential storage without data loss');
const legacyDb = new DatabaseSync(':memory:');
legacyDb.exec(
  "CREATE TABLE users (id INTEGER PRIMARY KEY, password_hash TEXT, role TEXT " +
  "CHECK (role IN ('controller','developer','super_seller'))); " +
  "INSERT INTO users (id, password_hash, role) VALUES (1, 'existing-hash', 'controller');"
);
require('../db/migrate').upgrade(legacyDb);
const migratedUser = legacyDb.prepare('SELECT password_hash, password_encrypted FROM users WHERE id = 1').get();
check('legacy password hash remains intact', 'existing-hash', migratedUser.password_hash);
check('legacy encrypted password column is added', true,
  legacyDb.prepare('PRAGMA table_info(users)').all().some(function (column) {
    return column.name === 'password_encrypted';
  }));
legacyDb.close();

console.log('\n=== panel credentials are encrypted and visible after each tier is created');
let parent = { username: 'admin', password: 'admin123' };
const madePanels = [];
tiers.forEach(function (tier, index) {
  const jar = login(parent.username, parent.password);
  const username = 'SCD' + process.pid + '_' + index;
  const result = request('/add_user', { user_name: username, password: PASSWORD, role: tier[0] }, jar, true);
  check(tier[0] + ' creation list shows success details immediately', true,
    result.body.includes(ROLES[tier[0]].label + ' panel ' + username + ' created.') &&
    result.body.includes('Login Details') && result.body.includes(username) &&
    result.body.includes('Copy All Details') && result.body.includes('created-panel-message'));
  check(tier[0] + ' screen includes ready-to-send WhatsApp login message', true,
    result.body.includes('Login Details') &&
    result.body.includes('Website URL: http://localhost:') &&
    result.body.includes('User ID: ' + username) &&
    result.body.includes('Password: ' + PASSWORD) &&
    result.body.includes('Copy All Details') &&
    result.body.includes('Send with WhatsApp'));

  const row = store.get('SELECT id, password_hash, password_encrypted FROM users WHERE username = ?', [username]);
  check(tier[0] + ' bcrypt login hash remains valid', true, bcrypt.compareSync(PASSWORD, row.password_hash));
  check(tier[0] + ' password is encrypted at rest', true,
    !!row.password_encrypted && row.password_encrypted !== PASSWORD && users.getPassword(row.id) === PASSWORD);
  check(tier[0] + ' saved panel record reopens the credentials', true,
    request('/panel_details/' + row.id, null, jar, true).body.includes('value="' + PASSWORD + '"'));

  madePanels.push(row.id);
  parent = { username, password: PASSWORD };
});

console.log('\n=== password reset updates the encrypted credential');
const controller = login('admin', 'admin123');
const changedPassword = 'ChangedSuccess123!';
request('/status_update', { id: madePanels[0], password: changedPassword }, controller, true);
check('reset password is available from the saved panel details', changedPassword,
  users.getPassword(madePanels[0]));
check('reset password also updates the login hash', true,
  bcrypt.compareSync(changedPassword, store.get('SELECT password_hash FROM users WHERE id = ?', [madePanels[0]]).password_hash));

console.log('\n=== legacy panels can set a new viewable password from their details page');
store.run('UPDATE users SET password_encrypted = NULL WHERE id = ?', [madePanels[0]]);
const legacyDetails = request('/panel_details/' + madePanels[0], null, controller, true);
check('legacy panel explains password recovery and offers reset', true,
  legacyDetails.body.includes('The existing password cannot be recovered.') &&
  legacyDetails.body.includes('/panel_details/' + madePanels[0] + '/reset-password'));
const replacementPassword = 'ReplacementSuccess123!';
const resetDetails = request('/panel_details/' + madePanels[0] + '/reset-password', {
  new_password: replacementPassword
}, controller, true);
check('new password is shown after details-page reset', true,
  resetDetails.body.includes('Password updated.') &&
  resetDetails.body.includes('value="' + replacementPassword + '"'));
check('details-page reset updates the login hash and encrypted credential', true,
  bcrypt.compareSync(replacementPassword,
    store.get('SELECT password_hash FROM users WHERE id = ?', [madePanels[0]]).password_hash) &&
  users.getPassword(madePanels[0]) === replacementPassword);

console.log('\n=== key generation details remain available from its key record');
const seller = parent;
const sellerJar = login(seller.username, seller.password);
const keyName = 'SUCCESSKEY' + process.pid;
prices.set('setup_link', 'https://downloads.example.test/galaxy-setup.exe');
const keyResponse = request('/generate_key', {
  name: keyName,
  client_name: 'Success Customer',
  mac: 'AA:BB:CC:DD:EE:FF'
}, sellerJar, true);
check('key generation shows key success screen', true,
  keyResponse.body.includes('Key Generated Successfully') && keyResponse.body.includes('Copy All Details'));
check('new key screen shows the website URL and key name in share format', true,
  keyResponse.body.includes('Website URL: http://localhost:') &&
  keyResponse.body.includes('Key name: ' + keyName) &&
  keyResponse.body.includes('data-copy="key-share-message"') &&
  keyResponse.body.includes('Send with WhatsApp') &&
  !keyResponse.body.includes('Success Customer') &&
  !keyResponse.body.includes('Final Setup Link'));

const key = keys.getByName(keyName);
check('key details can be reopened from its persistent record', true,
  request('/key_details/' + key.id, null, sellerJar, true).body.includes(keyName));
check('key name in the list does not open the details page', false,
  request('/all_key', null, sellerJar, true).body.includes('href="/key_details/' + key.id + '"'));
check('unrelated subtree cannot read panel credentials', 404,
  request('/panel_details/' + madePanels[0], null, sellerJar, true).status);

console.log('\n=== controller gift-key creation uses the same success screen');
const giftName = 'SUCCESSGIFT' + process.pid;
const giftResponse = request('/create_gift_key', {
  seller_name: seller.username,
  days: '1',
  name: giftName
}, controller, true);
check('gift key creation shows generated details', true,
  giftResponse.body.includes('Key Generated Successfully') &&
  giftResponse.body.includes(giftName) &&
  giftResponse.body.includes('Website URL: http://localhost:') &&
  giftResponse.body.includes('Key name: ' + giftName) &&
  !giftResponse.body.includes('Final Setup Link'));

console.log('\n=== public demo response includes matching key and setup links');
const demo = request('/create_demo_key', { client_name: 'demo_user' }, null, false);
const payload = JSON.parse(demo.body);
check('demo key response carries final and download links', true,
  payload.ok && payload.finalSetupLink.includes('/login?key=' + payload.key) &&
  payload.setupDownloadLink === 'https://downloads.example.test/galaxy-setup.exe' &&
  !!payload.keyDetails && !!payload.expiry);

const demoKey = keys.getByName(payload.key);
if (demoKey) keys.remove(demoKey.id);
if (key) keys.remove(key.id);
const gift = keys.getByName(giftName);
if (gift) keys.remove(gift.id);
if (madePanels.length) users.remove(madePanels[0]);
prices.set('setup_link', previousSetupLink);
cookieJars.forEach(function (jar) {
  if (fs.existsSync(jar)) fs.unlinkSync(jar);
});

if (failures) {
  console.error('\n' + failures + ' success-detail check(s) FAILED.');
  process.exit(1);
}
console.log('\nAll success-detail checks passed.');
