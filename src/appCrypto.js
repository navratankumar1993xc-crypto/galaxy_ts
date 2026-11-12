'use strict';
// Wire format shared with the client software (APP_FRAMEWORK.AesCrypto):
// PBKDF2-SHA1, 1000 rounds, 32-byte key, AES-256-CBC with a fixed IV.
const crypto = require('crypto');

const KEY = crypto.pbkdf2Sync('B@@Sw1rt', 'B@LT&KFY', 1000, 32, 'sha1');
const IV = Buffer.from('@1B2c3D4e5T6g7K8', 'utf8');

function encrypt(plainText) {
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, IV);
  return Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]).toString('base64');
}

function decrypt(cipherText) {
  const clean = String(cipherText || '').replace(/\s+/g, '');
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
  return Buffer.concat([decipher.update(Buffer.from(clean, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };