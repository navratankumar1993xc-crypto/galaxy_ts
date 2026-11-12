'use strict';
const { PUBLIC_BASE_URL } = require('./config');

function siteBaseUrl(req) {
  const configured = PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
  const url = new URL(configured);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_BASE_URL must use http:// or https://.');
  }
  return url.origin;
}

function loginUrl(req, keyName) {
  const url = new URL('/login', siteBaseUrl(req));
  url.searchParams.set('key', keyName);
  return url.href;
}

function safeHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Configured download links must use http:// or https://.');
  }
  return url.href;
}

module.exports = { siteBaseUrl, loginUrl, safeHttpUrl };
