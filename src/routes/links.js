'use strict';
const prices = require('../queries/prices');

// The three login-page download buttons. Stored in the settings table so the
// login route reads them fresh on every render — a save here is live on the
// website immediately, no restart.
const FIELDS = [
  { key: 'setup_link',   label: 'Setup Link',   icon: 'fas fa-cogs',       hint: 'Software setup download link' },
  { key: 'updater_link', label: 'Updater Link', icon: 'fas fa-sync-alt',   hint: 'Software updater download link' },
  { key: 'apk_link',     label: 'APK Link',     icon: 'fas fa-mobile-alt', hint: 'Mobile APK download link' }
];

function flash(req, type, text) {
  req.session.flash = [{ type, text }];
}

function page(req, res) {
  const settings = prices.all();
  res.render('controller/link_management', {
    links: FIELDS.map(function (f) {
      return Object.assign({}, f, { value: settings[f.key] || '' });
    })
  });
}

// One Save writes all three. Empty is allowed (the website button then points
// nowhere); a non-empty value must be an http(s) URL so a typo cannot silently
// publish a broken link.
function save(req, res) {
  const updates = [];
  for (const f of FIELDS) {
    const value = String(req.body[f.key] || '').trim();
    if (value && !/^https?:\/\/.+/i.test(value)) {
      flash(req, 'danger', f.label + ' must be a full link starting with http:// or https:// (or left empty).');
      return res.redirect('/link_management');
    }
    updates.push({ key: f.key, value, label: f.label });
  }
  for (const u of updates) prices.set(u.key, u.value);
  flash(req, 'success', 'Download links saved. The website buttons now use the new links.');
  res.redirect('/link_management');
}

module.exports = { page, save };