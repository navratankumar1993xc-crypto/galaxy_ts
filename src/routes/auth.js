'use strict';
const store = require('../../db');
const users = require('../../src/queries/users');
const prices = require('../../src/queries/prices');
const keys = require('../../src/queries/keys');

module.exports = function register(app) {
  // How long a demo runs on the website. The controller decides it by the number
  // it types into Start Demo on /all_key, which stores it as `demo_days`; the
  // login screen reads it back for both its label and its pre-filled field.
  const demoDays = function () {
    const n = Number(prices.all().demo_days);
    return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 2;
  };

  // Landing: straight to the dashboard when a session already exists.
  app.get('/', function (req, res) {
    res.redirect(req.session.uid ? '/home' : '/login');
  });

  // Download links come from the settings table (controller's Link
  // Management), read fresh so a save is live on the next page load.
  const downloadLinks = function () {
    const s = prices.all();
    return { setup: s.setup_link || '#', updater: s.updater_link || '#', apk: s.apk_link || '#' };
  };

  app.get('/login', function (req, res) {
    if (req.session.uid) return res.redirect('/home');
    res.render('login', {
      loginError: '',
      oldUsername: '',
      allowDemo: prices.all().allow_demo === '1',
      demoDays: demoDays(),
      links: downloadLinks()
    });
  });

  app.post('/login', function (req, res) {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const bad = function (message) {
      res.status(401).render('login', {
        loginError: message,
        oldUsername: username,
        allowDemo: prices.all().allow_demo === '1',
        demoDays: demoDays(),
        links: downloadLinks()
      });
    };

    const user = users.verify(username, password);
    if (!user) return bad('Invalid username or password.');
    if (user.status === 'closed') return bad('Your panel is closed. Clear the due to continue.');

    // Fresh session id on privilege change, so a pre-login cookie is useless.
    req.session.regenerate(function (err) {
      if (err) return bad('Could not start a session. Try again.');
      req.session.uid = user.id;
      req.session.flash = [{ type: 'success', text: 'Welcome back, ' + user.username + '!' }];
      res.redirect('/home');
    });
  });

  app.get('/logout', function (req, res) {
    req.session.destroy(function () {
      res.clearCookie('galaxy.sid');
      res.redirect('/login');
    });
  });

  // One click on the login screen's demo button. Mirrors create_demo_key.php:
  // JSON out, { ok, key, days, expiry } on success or { ok:false, msg }.
  app.post('/create_demo_key', function (req, res) {
    const settings = prices.all();
    if (settings.allow_demo !== '1') {
      return res.json({ ok: false, msg: 'Demo keys are currently disabled.' });
    }

    const controller = store.get("SELECT * FROM users WHERE role = 'controller' ORDER BY id LIMIT 1");
    if (!controller) return res.json({ ok: false, msg: 'Demo keys are unavailable right now.' });

    // The length is the controller's decision alone (the sidebar box / Start
    // Demo), which is what the button label already advertises — the page asks
    // for nothing, so whatever arrives in `days` is ignored. Each click issues
    // the next numbered key: DEMO01, DEMO02, DEMO03...
    const days = demoDays();
    const slot = keys.issueDemo({ owner: controller, days });
    const expiry = store.scalar('SELECT datetime(expire_date) FROM keys WHERE id = ?', [slot.id]);
    return res.json({ ok: true, key: slot.keyName, days: days, expiry: expiry });
  });
};
