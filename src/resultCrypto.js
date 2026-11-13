'use strict';
const crypto = require('crypto');
const path = require('path');
const cfg = require('./config');

// Canonical base64 of exactly 32 bytes; fail closed without affecting login.
const encoded = cfg.RESULTS_ENCRYPTION_KEY;
const master = /^[A-Za-z0-9+/]{43}=$/.test(encoded) ? Buffer.from(encoded, 'base64') : null;
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
const privateDirectory = !inside(path.join(cfg.ROOT, 'public'), cfg.RESULT_DIR) &&
  !inside(cfg.UPLOAD_DIR, cfg.RESULT_DIR);
const enabled = !!(master && master.length === 32 && master.toString('base64') === encoded && privateDirectory);
const configurationError = master && master.length === 32 && master.toString('base64') === encoded
  ? 'RESULTS_PRIVATE_DIRECTORY_REQUIRED' : 'RESULTS_ENCRYPTION_KEY_REQUIRED';
function derive(purpose) {
  if (!enabled) throw new Error('RESULTS_DISABLED');
  return crypto.createHmac('sha256', master).update('galaxy/booking-results/v1/' + purpose).digest();
}

function issueToken(key, mac, now = Date.now()) {
  if (!enabled) return '';
  const payload = Buffer.from(JSON.stringify({
    purpose: 'booking-results', keyId: Number(key.id), keyName: key.key_name, mac,
    exp: Math.floor(now / 1000) + 24 * 60 * 60
  })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', derive('token-signing')).update(payload).digest('base64url');
}

function verifyToken(token, now = Date.now()) {
  if (!enabled || typeof token !== 'string' || token.length > 4096) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const supplied = Buffer.from(match[2], 'base64url');
  const signature = crypto.createHmac('sha256', derive('token-signing')).update(match[1]).digest();
  if (supplied.length !== signature.length || !crypto.timingSafeEqual(signature, supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (!value || value.purpose !== 'booking-results' || !Number.isSafeInteger(value.exp) ||
        value.exp <= Math.floor(now / 1000) || value.exp > Math.floor(now / 1000) + 86400 ||
        !Number.isSafeInteger(value.keyId) || value.keyId < 1 ||
        typeof value.keyName !== 'string' || !value.keyName ||
        typeof value.mac !== 'string' || !value.mac || value.mac.length > 128) return null;
    return value;
  } catch (_) { return null; }
}

// Versioned binary envelope: magic, random nonce, authentication tag, ciphertext.
const MAGIC = Buffer.from('GALR1');
function seal(bytes, purpose, identity) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(purpose), iv);
  cipher.setAAD(Buffer.from(purpose + ':' + identity));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}
function open(bytes, purpose, identity) {
  const data = Buffer.from(bytes);
  if (data.length < 33 || !data.subarray(0, 5).equals(MAGIC)) throw new Error('INVALID_RESULT');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derive(purpose), data.subarray(5, 17));
  decipher.setAAD(Buffer.from(purpose + ':' + identity));
  decipher.setAuthTag(data.subarray(17, 33));
  return Buffer.concat([decipher.update(data.subarray(33)), decipher.final()]);
}
module.exports = { enabled, configurationError, issueToken, verifyToken, seal, open };
