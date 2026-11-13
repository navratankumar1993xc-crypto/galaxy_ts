'use strict';
const prices = require('../queries/prices');
const keys = require('../queries/keys');
const news = require('../queries/news');
const resultCrypto = require('../resultCrypto');

const EMPTY_FIELDS = {
  appVersion: '',
  ipList: '',
  ShortMessage: '',
  KeyType: '',
  paid: '',
  edata: '',
  S3URL: '',
  pass: '',
  sdata: '',
  BatchNo: ''
};

function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

function authorized(req, keyName) {
  const header = String(req.get('authorization') || '');
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (!match) return false;

  let credentials;
  try {
    credentials = Buffer.from(match[1], 'base64').toString('utf8');
  } catch (err) {
    return false;
  }

  const separator = credentials.indexOf(':');
  if (separator < 1) return false;
  const timestamp = Number(credentials.slice(0, separator));
  const suppliedKey = credentials.slice(separator + 1);
  return Number.isSafeInteger(timestamp) &&
    Math.abs(Date.now() - timestamp) <= 5 * 60 * 1000 &&
    suppliedKey === keyName;
}

function reply(res, success, message, key = null, mac = key ? key.mac : '') {
  // Fetch latest app news to show in software popup
  let shortMsg = '';
  try {
    const latestNews = news.latestTickerFor('appnews');
    console.log('[license] latestNews:', latestNews);
    if (latestNews && latestNews.body) {
      shortMsg = latestNews.body.replace(/\r\n/g, '@').replace(/\n/g, '@');
    }
  } catch (e) {
    console.log('[license] news error:', e.message);
  }

  res.set('Cache-Control', 'no-store');
  const payload = Object.assign({}, EMPTY_FIELDS, {
    success,
    message,
    leftDays: key ? Number(key.left_days) : 0,
    ipList: key ? key.ips || '' : '',
    KeyType: key ? (key.type === 'demo' ? 'demo' : 'normal') : '',
    paid: key ? (Number(key.has_paid) ? 'Paid' : 'Unpaid') : '',
    ShortMessage: shortMsg
  });
  if (success && key) {
    const token = resultCrypto.issueToken(key, mac);
    if (token) payload.resultUploadToken = token;
  }
  return res.json(payload);
}

function validate(req, res) {
  if (!isLoopback(req)) {
    return res.status(403).json({ success: false, message: 'Local requests only.' });
  }

  const body = req.body || {};
  const keyName = String(body.userName || '').trim();
  const mac = String(body.macAddress || '').trim();
  if (!keyName || !mac || mac.length > 128) {
    return reply(res, false, 'A license key and device ID are required.');
  }
  if (!authorized(req, keyName)) {
    return reply(res, false, 'The license request could not be verified.');
  }

  keys.enforceCascades(prices.all());
  const key = keys.getByName(keyName);
  if (!key) return reply(res, false, 'License key not found.');
  if (key.status !== 'active') return reply(res, false, 'This license key is inactive.', key);
  if (Number(key.left_days) < 0) return reply(res, false, 'License key expired.', key);
  if (key.mac && key.mac !== mac) {
    return reply(res, false, 'This license key is registered to another device.', key);
  }
  if (!key.mac) keys.setMac(key.id, mac);

  return reply(res, true, 'License valid.', key, mac);
}

module.exports = { validate };
