'use strict';
const store = require('../../db');
const keyTokens = require('../queries/keyTokens');
const prices = require('../queries/prices');
const { subtreeIds } = require('../queries/tree');

const TYPES = ['app', 'beta'];

function normType(v) {
  const t = String(v || 'app').trim().toLowerCase();
  return TYPES.includes(t) ? t : null;
}

// Accept a key_name (DEMO01) or a numeric keys.id. mac is the device ID
// registered at license validation; the sensor GET matches against it.
function findKey(ref) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return null;
  let k = store.get('SELECT id, key_name, status, created_by_id, mac FROM keys WHERE key_name = ?', [s]);
  if (!k && /^\d+$/.test(s)) {
    k = store.get('SELECT id, key_name, status, created_by_id, mac FROM keys WHERE id = ?', [Number(s)]);
  }
  return k || null;
}

// Split a textarea / array / single string into individual token lines.
// The APK posts { sensors: [ "<dll line>", ... ] }; the panel posts tokens.
// Each sensors element is already one full DLL line, so it is stored verbatim.
function tokenList(body) {
  let raw = body.sensors != null ? body.sensors
    : body.tokens != null ? body.tokens
      : body.token;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(x => String(x));
  return String(raw).split(/\r?\n/);
}

// ------------------------------------------------------- POST /api/tokens
// Push tokens against a key from anywhere (curl, panel, external tool).
// Accepts the APK wire shape { sensors:[...], timestamp, userId } as well as
// the panel shape { key|key_id, type, tokens }. userId maps to the key; type
// defaults to 'app' when the APK omits it.
function apiPost(req, res) {
  const body = req.body || {};
  const keyRef = body.key != null ? body.key
    : body.key_id != null ? body.key_id
      : body.userId;
  const key = findKey(keyRef);
  if (!key) return res.status(404).json({ ok: false, msg: 'Unknown key.' });
  const type = normType(body.type);
  if (!type) return res.status(400).json({ ok: false, msg: "type must be 'app' or 'beta'." });
  const list = tokenList(body).map(t => t.trim()).filter(Boolean);
  if (!list.length) return res.status(400).json({ ok: false, msg: 'No tokens supplied.' });
  const added = keyTokens.add(key.id, type, list);
  res.json({ ok: true, added, key: key.key_name, type });
}

// -------------------------------------------------------- GET /api/tokens
// The client software pulls its pending tokens once; they are marked consumed
// so a repeat click does not hand out the same token again. Response carries
// both shapes: the software's TeslaTSTokenResponseNew { success, message,
// tokens[] } and the APK wire fields { sensors, timestamp, userId }. sensors
// and tokens are the same DLL-format lines; Newtonsoft ignores the extras.
function apiGet(req, res) {
  const key = findKey(req.query.key != null ? req.query.key : req.query.userId);
  const userId = key ? key.key_name : '';
  const timestamp = Date.now();
  if (!key) {
    return res.json({ success: false, message: 'Unknown key.', tokens: [], sensors: [], timestamp, userId });
  }
  if (key.status !== 'active') {
    return res.json({ success: false, message: 'Your License is BLOCKED from fetching Tokens.', tokens: [], sensors: [], timestamp, userId });
  }
  const rows = keyTokens.pending(key.id);
  keyTokens.consume(rows.map(r => r.id));
  const tokens = rows.map(r => r.token);
  res.json({ success: true, message: '', tokens, sensors: tokens, timestamp, userId });
}

// ------------------------------------------- POST /api/akamai/sensor/:keyname
// APK pushes sensors against a key. keyname comes from the path; NO mac needed
// on POST. Body { sensors:[...], timestamp, ... } (legacy tokens also accepted).
// Type is an upload label only; either software button can fetch these tokens.
function sensorPost(req, res) {
  const key = findKey(req.params.keyname);
  if (!key) return res.status(404).json({ ok: false, msg: 'Unknown key.' });
  const body = req.body || {};
  const type = normType(body.type);
  if (!type) return res.status(400).json({ ok: false, msg: "type must be 'app' or 'beta'." });
  const list = tokenList(body).map(t => t.trim()).filter(Boolean);
  if (!list.length) return res.status(400).json({ ok: false, msg: 'No tokens supplied.' });
  const added = keyTokens.add(key.id, type, list);
  res.json({ ok: true, added, key: key.key_name, type });
}

// -------------------------------------------- GET /api/akamai/sensor/:keyname
// The button selects the local file; stored type labels must not restrict delivery.
function sensorGet(req, res) {
  const key = findKey(req.params.keyname);
  const userId = key ? key.key_name : '';
  const timestamp = Date.now();
  const fail = (message) => res.json({ success: false, message, tokens: [], sensors: [], timestamp, userId });
  if (!key) return fail('Unknown key.');
  if (key.status !== 'active') return fail('Your License is BLOCKED from fetching Tokens.');
  const mac = String(req.query.mac_address == null ? '' : req.query.mac_address).trim();
  if (!mac) return fail('mac_address is required.');
  if (!key.mac) return fail('No MAC address registered for this key.');
  if (key.mac !== mac) return fail('MAC address does not match this key.');
  const rows = keyTokens.pending(key.id);
  keyTokens.consume(rows.map(r => r.id));
  const tokens = rows.map(r => r.token);
  res.json({ success: true, message: '', tokens, sensors: tokens, timestamp, userId });
}

// ----------------------------------------------------- GET /api/appconfig
// Token Manager header: block flag + the two APK links the QR codes are built
// from. Field names match what the client already parses.
function apiAppConfig(req, res) {
  const key = findKey(req.query.userId);
  const settings = prices.all();
  res.json({
    is_blocked: !key || key.status !== 'active',
    apk_1_title: 'APK Link (Server 1)',
    apk_1_link: settings.apk_app_link || '',
    apk_2_title: 'APK Link (Beta)',
    apk_2_link: settings.apk_beta_link || ''
  });
}

// --------------------------------------------------------- /key_tokens
function page(req, res) {
  const me = res.locals.me;
  res.render('controller/key_tokens', { rows: keyTokens.pendingByRoot(me.id) });
}

function save(req, res) {
  const me = res.locals.me;
  const key = findKey(req.body.key_id);
  const type = normType(req.body.type);
  const list = tokenList(req.body).map(t => t.trim()).filter(Boolean);
  if (!key || !subtreeIds(me.id).includes(key.created_by_id)) {
    req.session.flash = [{ type: 'danger', text: 'Key not found in your tree.' }];
    return res.redirect('/key_tokens');
  }
  if (!type || !list.length) {
    req.session.flash = [{ type: 'danger', text: 'Choose a type and paste at least one token.' }];
    return res.redirect('/key_tokens');
  }
  const added = keyTokens.add(key.id, type, list);
  req.session.flash = [{ type: 'success', text: added + ' ' + type.toUpperCase() + ' token(s) pushed to ' + key.key_name + '.' }];
  res.redirect('/key_tokens');
}

module.exports = { apiPost, apiGet, sensorPost, sensorGet, apiAppConfig, page, save };