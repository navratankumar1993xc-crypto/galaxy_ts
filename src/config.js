'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// The reference site sets its headings in Mathematical Bold glyphs, and keeps
// the original letter case, so "Secure" is 𝐒𝐞𝐜𝐮𝐫𝐞. Those live in the
// Mathematical Alphanumeric Symbols block: bold capitals at U+1D400, bold
// small letters at U+1D41A, bold digits at U+1D7CE.
// ---------------------------------------------------------------------------
function boldText(text) {
  return String(text).replace(/[A-Za-z0-9]/g, ch => {
    if (ch >= 'A' && ch <= 'Z') return String.fromCodePoint(0x1d400 + (ch.charCodeAt(0) - 65));
    if (ch >= 'a' && ch <= 'z') return String.fromCodePoint(0x1d41a + (ch.charCodeAt(0) - 97));
    return String.fromCodePoint(0x1d7ce + (ch.charCodeAt(0) - 48));
  });
}

// All-caps variant, which is what the panel headings use.
function bold(ascii) {
  return boldText(String(ascii).toUpperCase());
}

// ---------------------------------------------------------------------------
// Brand strings. Reference site is COCKROACH; this build is identical apart
// from the name, so every brand-bearing string lives here and nowhere else.
// ---------------------------------------------------------------------------
const BRAND = {
  name: 'Galaxy',
  nameUpper: 'GALAXY',
  nameBold: bold('GALAXY'),
  title: bold('GALAXY') + ' Panel',
  logo: '/img/galaxy_logo.png',
  // The reference has two footers: the DataTables pages are still on the old
  // AdminLTE markup with "Version 1.0.0", the rest say "Version 2.0.0 / Remix UI".
  version: '2.0.0 / Remix UI',
  legacyVersion: '1.0.0',
  team: bold('TEAM') + ' ' + bold('GALAXY'),
  // Reference ticker: "🚀 𝐂𝐎𝐂𝐊𝐑𝐎𝐀𝐂𝐇 𝐂𝐎𝐍𝐓𝐑𝐎𝐋 𝐏𝐍𝐄𝐋 - Welcome Controller!"
  ticker(roleLabel) {
    return '\u{1F680} ' + bold('GALAXY') + ' ' + bold('CONTROL') + ' ' + bold('PANEL') +
      ' - Welcome ' + roleLabel + '!';
  },

  // Login screen copy, string for string the same shape as the reference.
  login: {
    title:          boldText('GALAXY') + ' — ' + boldText('Secure Access'),
    subtitle:       boldText('System Secure Portal Access'),
    username:       boldText('Username'),
    password:       boldText('Password'),
    userPlaceholder: boldText('Enter username'),
    passPlaceholder: boldText('Enter password'),
    signIn:         boldText('Sign In to Dashboard'),
    accessing:      boldText('Accessing Server...'),
    // The reference hardcodes "2-Day" because its build had no way to choose a
    // length. Here the controller decides it (the days box on their sidebar,
    // stored as `demo_days`), and this label is built from that number — so the
    // website always advertises, and always hands out, the demo the controller
    // chose. The button is the whole request: no second step, no field to fill.
    demo:           function (days) { return boldText('Generate ' + days + '-Day Demo Key'); },
    fetching:       boldText('Fetching...'),
    yourKey:        boldText('Your Key'),
    expiry:         '⏳ Expiry Date: ',
    copy:           boldText('Copy'),
    copied:         boldText('Copied!'),
    resources:      boldText('Resources'),
    downloadUpdater: boldText('Download Updater'),
    setupNew:       boldText('GALAXY SETUP'),
    latestApk:      boldText('LATEST APK APP LOGIN'),
    footerBadge:    boldText('GALAXY SECURED PANEL · 2026')
    // Download URLs are not hardcoded here: the controller owns them on
    // /link_management (settings keys setup_link / updater_link / apk_link),
    // and the login route reads them fresh on every render.
  }
};

// ---------------------------------------------------------------------------
// Tier order, top to bottom. `next` is the role this tier may create, and the
// sidebar label for a tier's list page is derived from `label` in src/menu.js,
// so this table carries only what the code reads.
//
// The reference chain ends Admin -> Seller; the owner asked for a Super Seller
// level in between, so the tree is one deeper and every list page, price row
// and key-lineage column below it follows from here.
// ---------------------------------------------------------------------------
const ROLES = {
  controller:         { label: 'Controller',         next: 'developer' },
  developer:          { label: 'Developer',          next: 'super_master_admin' },
  super_master_admin: { label: 'Super Master Admin', next: 'master_admin' },
  master_admin:       { label: 'Master Admin',       next: 'admin' },
  admin:              { label: 'Admin',              next: 'super_seller' },
  super_seller:       { label: 'Super Seller',       next: 'seller' },
  seller:             { label: 'Seller',             next: null }
};

const ROLE_ORDER = ['controller', 'developer', 'super_master_admin', 'master_admin', 'admin', 'super_seller', 'seller'];

// Chain column on the `keys` table that corresponds to each role.
const CHAIN_COLUMN = Object.entries(ROLES)
  .filter(([role]) => role !== 'controller')
  .reduce(function (out, [role]) {
    out[role] = role + '_id';
    return out;
  }, {});

// Sidebar / list-page routes, matching the reference wording.
const PANEL_LIST_ROUTE = {
  developer: 'all_developer_panels',
  super_master_admin: 'all_super_master_admins',
  master_admin: 'all_master_admins',
  admin: 'all_admins',
  super_seller: 'all_super_sellers',
  seller: 'all_seller'
};

// The tiers that own a lineage column on `keys`, top to bottom: the column, the
// field name the list views read, and the column heading. `admin` keeps the
// `admin_name` field because the key table already prints it that way.
const CHAIN_TIERS = ROLE_ORDER.filter(role => role !== 'controller').map(function (role) {
  return {
    role,
    column: CHAIN_COLUMN[role],
    field: role === 'admin' ? 'admin_name' : role,
    label: ROLES[role].label,
    route: PANEL_LIST_ROUTE[role]
  };
});

const DEFAULT_SETTINGS = {
  key_grace_hours: '48',    // unpaid/expired keys suspend after this many hours
  child_grace_hours: '24',  // when a panel closes, its children's keys survive this long
  allow_demo: '1',          // sidebar "Allow demo key" switch
  demo_days: '2',           // how long a demo runs; the controller's sidebar days box sets it
  // The one validity a seller may create keys at. The controller sets it on
  // /all_key ("Seller Key Validity (Days)"); sellers cannot choose or exceed it.
  panel_days: '30',
  // Login-page download links. Only the controller edits these, on
  // /link_management; empty means the button still shows but goes nowhere.
  setup_link: '',
  updater_link: '',
  apk_link: '',
  // Token Manager QR targets. The controller edits these on /link_management;
  // the client software reads them from /api/appconfig and builds the QR codes.
  apk_app_link: '',
  apk_beta_link: ''
};

// Observed on the reference /set_price table, with the Super Seller row slotted
// between Admin and Seller at the midpoint price.
const DEFAULT_ROLE_PRICES = {
  controller:         { price: 600,   cutoff_hour: 0 },
  developer:          { price: 800,   cutoff_hour: 12 },
  super_master_admin: { price: 900,   cutoff_hour: 12 },
  master_admin:       { price: 1000,  cutoff_hour: 15 },
  admin:              { price: 1100,  cutoff_hour: 2 },
  super_seller:       { price: 1150,  cutoff_hour: 4 },
  seller:             { price: 1200,  cutoff_hour: 6 }
};

// ---------------------------------------------------------------------------
// Date labels. The reference prints "07 Nov 2026" on the report header and
// "07 Nov" under the token chart. node:sqlite's strftime() answers NULL for the
// %b month-name token, so these labels are built here from the ISO date.
// ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateLabel(value, withYear = true) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!parts) return value;
  const label = parts[3] + ' ' + MONTHS[Number(parts[2]) - 1];
  return withYear ? label + ' ' + parts[1] : label;
}

module.exports = {
  ROOT,
  // The check runner points GALAXY_DB at a throwaway database it deletes
  // afterwards; without it the panel always uses the owner's working data.
  DB_FILE: process.env.GALAXY_DB
    ? path.resolve(process.env.GALAXY_DB)
    : path.join(ROOT, 'data', 'galaxy.db'),
  UPLOAD_DIR: path.join(ROOT, 'data', 'uploads'),
  RESULT_DIR: process.env.GALAXY_RESULT_DIR
    ? path.resolve(process.env.GALAXY_RESULT_DIR)
    : path.join(ROOT, 'data', 'results'),
  // Deliberately independent of SESSION_SECRET: no fallback or generated key.
  RESULTS_ENCRYPTION_KEY: process.env.RESULTS_ENCRYPTION_KEY || '',
  // The reference stamps its theme stylesheet with a cache-buster query; ours is
  // the file's own mtime, which is what that number is on the original.
  ASSET_VERSION: (() => {
    try {
      return Math.floor(fs.statSync(path.join(ROOT, 'public', 'css', 'theme-pro.css')).mtimeMs / 1000);
    } catch (err) {
      return 0;
    }
  })(),
  PORT: Number(process.env.PORT || 3000),
  SESSION_SECRET: process.env.SESSION_SECRET || 'galaxy-panel-local-secret',
  // Set this to the site's public origin when it differs from the request host
  // (for example, when TLS terminates at a reverse proxy).
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '',
  bold,
  boldText,
  BRAND,
  ROLES,
  ROLE_ORDER,
  CHAIN_COLUMN,
  CHAIN_TIERS,
  PANEL_LIST_ROUTE,
  DEFAULT_SETTINGS,
  DEFAULT_ROLE_PRICES,
  // Public demo keys are numbered from this prefix (DEMO01, DEMO02, ...), so a
  // visitor gets a short key they can type instead of a random 10-character one.
  DEMO_KEY_PREFIX: 'DEMO',
  roleLabel(role) { return (ROLES[role] || { label: role }).label; },
  dateLabel,
  inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
};
