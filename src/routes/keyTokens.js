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

// Accept a key_name (DEMO01) or a numeric keys.id.
function findKey(ref) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return null;
  let k = store.get('SELECT id, key_name, status, created_by_id FROM keys WHERE key_name = ?', [s]);
  if (!k && /^\d+$/.test(s)) {
    k = store.get('SELECT id, key_name, status, created_by_id FROM keys WHERE id = ?', [Number(s)]);
  }
  return k || null;
}

// Split a textarea / array / single string into individual token lines.
function tokenList(body) {
  let raw = body.tokens != null ? body.tokens : body.token;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(x => String(x));
  return String(raw).split(/\r?\n/);
}

// ------------------------------------------------------- POST /api/tokens
// Push tokens against a key from anywhere (curl, panel, external tool).
function apiPost(req, res) {
  const body = req.body || {};
  const key = findKey(body.key != null ? body.key : body.key_id);
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
// so a repeat click does not hand out the same token again. Shape matches the
// software's TeslaTSTokenResponseNew { success, message, tokens[] }.
function apiGet(req, res) {
  const key = findKey(req.query.key);
  if (!key) return res.json({ success: false, message: 'Unknown key.', tokens: [] });
  if (key.status !== 'active') {
    return res.json({ success: false, message: 'Your License is BLOCKED from fetching Tokens.', tokens: [] });
  }
  const type = normType(req.query.type) || 'app';
  const rows = keyTokens.pending(key.id, type);
  keyTokens.consume(rows.map(r => r.id));
  res.json({ success: true, message: '', tokens: rows.map(r => r.token) });
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

module.exports = { apiPost, apiGet, apiAppConfig, page, save };