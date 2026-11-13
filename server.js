'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

const cfg = require('./src/config');
const store = require('./db');
const auth = require('./src/auth');
const seed = require('./db/seed');
const registerPublicRoutes = require('./src/routes/auth');
const pages = require('./src/routes/pages');
const userPages = require('./src/routes/users');
const keyPages = require('./src/routes/keys');
const money = require('./src/routes/money');
const pricePages = require('./src/routes/prices');
const newsPages = require('./src/routes/news');
const reportPages = require('./src/routes/reports');
const tokenPages = require('./src/routes/tokens');
const resultPages = require('./src/routes/results');
const status = require('./src/routes/status');
const linkPages = require('./src/routes/links');
const license = require('./src/routes/license');
const limits = require('./src/routes/limits');
const keyTokens = require('./src/routes/keyTokens');

// A fresh checkout has no database rows; create the controller and pricing
// before the first request is served.
const hasController = store.scalar(`SELECT id FROM users WHERE role = 'controller' LIMIT 1`);
if (!hasController) {
  seed.bootstrap();
}

fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true });

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(cfg.ROOT, 'views'));
app.set('trust proxy', false);

app.use(express.static(path.join(cfg.ROOT, 'public'), { maxAge: '1h' }));
// Bearer-authenticated uploads use their own bounded parser, before any body
// or session middleware can consume the request or redirect it to login.
app.post('/api/results', resultPages.apiResults);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  name: 'galaxy.sid',
  secret: cfg.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(auth.locals);
app.use(auth.enforceRules);

// /login, /logout, /create_demo_key, /
registerPublicRoutes(app);

// The client software posts usage tokens here; no session, like the reference.
app.post('/api/token', tokenPages.apiToken);
app.post('/api/license/validate', license.validate);
app.post('/api/limits', limits.apiLimits);
// Per-key token pool: push from anywhere, pull once from the client software.
// Old wire endpoint — replaced by /api/akamai/sensor/:keyname below.
// app.post('/api/tokens', keyTokens.apiPost);
// app.get('/api/tokens', keyTokens.apiGet);
// APK sensor endpoint: POST by keyname (no mac); GET validates mac_address
// against the key's registered MAC. Same endpoint serves app and beta (type).
app.post('/api/akamai/sensor/:keyname', keyTokens.sensorPost);
app.get('/api/akamai/sensor/:keyname', keyTokens.sensorGet);
// Token Manager header: block flag + the APK links the QR codes are built from.
app.get('/api/appconfig', keyTokens.apiAppConfig);

// Every other page needs a session.
app.use(function (req, res, next) {
  if (req.path.startsWith('/api/')) return next();
  return auth.requireLogin(req, res, next);
});

// Legacy ticket scans remain available only to the controller, never cached.
app.use('/uploads', function (req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  next();
}, auth.requireRole('controller'), express.static(cfg.UPLOAD_DIR, { cacheControl: false }));

app.get('/home', pages.home);
app.post('/toggle_demo', auth.requireRole('controller'), pages.toggleDemo);

// Panel management is shared by every tier; the subtree filter decides how
// much of the tree each one can see.
app.get('/add_user', userPages.addForm);
app.post('/add_user', userPages.addSubmit);
app.get('/panel_details/:id', userPages.panelDetails);
app.post('/panel_details/:id/reset-password', userPages.resetPanelPassword);
Object.keys(userPages.LIST_PAGES).forEach(function (route) {
  app.get('/' + route, userPages.list(route));
});
// One endpoint, five operations, exactly as the reference shares it:
// ?u_id= toggles a panel, ?r_id= unregisters one key, ?ac_id= flips a key,
// ?f_id= deletes a price row, ?n_id= deletes a broadcast.
app.get('/status_update', status.handle);
app.post('/status_update', userPages.statusUpdate);
app.post('/delete_user_cascade', userPages.deleteCascade);
// Direct Login: the controller enters any panel below it without that panel's
// password, and returns with Back to Controller. The target password is untouched.
app.post('/direct_login', userPages.directLogin);
app.post('/back_to_controller', userPages.backToController);

// Keys: the list page, then the row and bulk operations the reference exposes.
app.get('/all_key', keyPages.list);
app.post('/all_key', keyPages.toolbar);
app.post('/generate_key', keyPages.generate);
app.get('/key_details/:id', keyPages.keyDetails);
app.post('/extend_id', keyPages.extend);
// Edit Validity: the controller sets a key's exact days, up or down; the change
// is logged to the validity history.
app.post('/edit_validity', keyPages.editValidity);
app.post('/set_seller_days', keyPages.setSellerDays);
app.post('/create_gift_key', keyPages.createGift);
app.post('/transfer_gift_key', keyPages.transferGift);
// Complete Key Transfer: the controller moves a key to another panel together
// with its whole account — payments, dues, receipts, resets and validity trail.
app.post('/transfer_key', keyPages.transferKey);
app.post('/update_client_name', keyPages.updateClientName);
app.post('/delete_key', keyPages.remove);
app.post('/add_proxy', keyPages.addProxy);
// A child's key stays UnPaid until the panel above it marks it Paid, which is
// also the moment the child is billed its own role price.
app.post('/mark_key_paid', keyPages.markPaid);
// The seller flips a near-expiry Paid key back to UnPaid; the parent's mark-paid
// is what raises the renewal Due and adds the days.
app.post('/renew_key', keyPages.renewKey);

// Money pages, shared by every tier; the subtree decides whose money you see.
app.get('/transaction', money.transaction);
app.get('/payment_receiving_history', money.paymentReceivingHistory);
app.post('/send_payment', money.sendPayment);
app.post('/accept_payment', money.acceptPayment);
// One payment's receipt: sender, receiver and the controller only.
app.get('/receipt', money.receipt);
// The controller's complete transfer trail — which key moved where and what of
// its account travelled with it.
app.get('/transfer_history', money.transferHistory);

// Broadcasts and the creation report.
app.get('/news', newsPages.page);
app.post('/news', newsPages.send);
app.get('/reports', reportPages.page);

// Controller-only: pricing, the token monitor and the ticket results.
app.get('/set_price', auth.requireRole('controller'), pricePages.page);
app.post('/set_price', auth.requireRole('controller'), pricePages.save);
// Per-key pair limits the client software fetches from /api/limits.
app.get('/pair_limits', auth.requireRole('controller'), limits.page);
app.post('/pair_limits', auth.requireRole('controller'), limits.save);
// Per-key token pool: push tokens and watch pending counts.
app.get('/key_tokens', auth.requireRole('controller'), keyTokens.page);
app.post('/key_tokens', auth.requireRole('controller'), keyTokens.save);
// Login-page download links: controller-only, same guard on page and save.
app.get('/link_management', auth.requireRole('controller'), linkPages.page);
app.post('/link_management', auth.requireRole('controller'), linkPages.save);
app.get('/token_stats', auth.requireRole('controller'), tokenPages.page);
app.get('/result_image/:id', auth.requireRole('controller'), resultPages.resultImage);
app.get('/today_result', auth.requireRole('controller'), resultPages.todayResult);
app.get('/top_result', auth.requireRole('controller'), resultPages.topResult);

// Anything not built yet is a plain 404, same as the reference.
app.use(function (req, res) {
  res.status(404).render('error', { code: 404, message: 'Page not found.' });
});

app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).render('error', { code: 500, message: 'Something went wrong on the server.' });
});

app.listen(cfg.PORT, function () {
  console.log(cfg.BRAND.nameUpper + ' Panel running on http://localhost:' + cfg.PORT);
});
