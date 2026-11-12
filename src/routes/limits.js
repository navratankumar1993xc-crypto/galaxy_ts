'use strict';
const keys = require('../queries/keys');
const appCrypto = require('../appCrypto');

// Same fallback the client software applies when the panel cannot be reached.
const DEFAULTS = { limit_total: 2, limit_app: 2, limit_beta: 1 };
const MIN = 1;
const MAX = 100;

function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

// ------------------------------------------------------------- /api/limits
// The client posts {"payload": "<aes base64 of {\"key\": ...}>"} and reads back
// an aes base64 JSON of the three limits, exactly like the old limit.php.
function apiLimits(req, res) {
  if (!isLoopback(req)) {
    return res.status(403).json({ success: false, message: 'Local requests only.' });
  }

  let keyName = '';
  try {
    const payload = JSON.parse(appCrypto.decrypt(String((req.body || {}).payload || '')));
    keyName = String(payload.key || '').trim();
  } catch (err) {
    return res.type('text').send('');
  }

  const key = keyName ? keys.getByName(keyName) : null;
  const limits = key
    ? { limit_total: Number(key.limit_total), limit_app: Number(key.limit_app), limit_beta: Number(key.limit_beta) }
    : Object.assign({ found: false }, DEFAULTS);

  res.set('Cache-Control', 'no-store');
  return res.type('text').send(appCrypto.encrypt(JSON.stringify(limits)));
}

// ------------------------------------------------------------- /pair_limits
function page(req, res) {
  res.render('controller/pair_limits', { rows: keys.pairLimitRows(), MIN, MAX });
}

function save(req, res) {
  const id = Number(req.body.key_id);
  const values = ['limit_total', 'limit_app', 'limit_beta'].map(function (f) { return Number(req.body[f]); });
  const key = keys.get(id);
  if (!key || values.some(function (v) { return !Number.isInteger(v) || v < MIN || v > MAX; })) {
    req.session.flash = [{ type: 'danger', text: 'Pair limits must be whole numbers between ' + MIN + ' and ' + MAX + '.' }];
    return res.redirect('/pair_limits');
  }
  keys.setPairLimits(id, values[0], values[1], values[2]);
  req.session.flash = [{
    type: 'success',
    text: 'Pair limits for ' + key.key_name + ' saved: Total ' + values[0] +
      ', App/Super ' + values[1] + ', Beta ' + values[2] + '. Software agle fetch par naye limits lega.'
  }];
  res.redirect('/pair_limits');
}

module.exports = { apiLimits, page, save };