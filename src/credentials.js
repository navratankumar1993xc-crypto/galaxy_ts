'use strict';
const crypto = require('crypto');
const { SESSION_SECRET } = require('./config');

// Configure CREDENTIALS_ENCRYPTION_KEY in production so credential-at-rest
// encryption is independent of the session secret and database contents.
const key = crypto.createHash('sha256')
  .update(process.env.CREDENTIALS_ENCRYPTION_KEY || SESSION_SECRET)
  .digest();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url')].join('.');
}

function decrypt(value) {
  if (!value) return null;
  const [version, ivText, tagText, ciphertextText] = String(value).split('.');
  if (version !== 'v1' || !ivText || !tagText || ciphertextText === undefined) {
    throw new Error('Stored panel credential has an unsupported format.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
