'use strict';
// Reference walk-through, markup level. Screenshots were not available in this
// session (the in-app browser surface stays hidden), so the comparison is done
// on the two things that decide whether a page looks the same: the visible text
// and the form/table structure.
//
//   node scripts/compare_ref.js [--ref DIR]
//
// Data-driven tokens (numbers, dates, usernames, key names, ids) are filtered
// out, as are the brand words, so a clean run means only branding and live data
// differ from the reference.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REF = process.argv.includes('--ref')
  ? process.argv[process.argv.indexOf('--ref') + 1]
  : path.join(process.env.TEMP, 'galaxy_ref');
const T = process.env.TEMP;
const B = 'http://localhost:3000';

const PAGES = ['home', 'add_user', 'all_user', 'all_developer_panels', 'all_super_master_admins',
  'all_master_admins', 'all_admins', 'all_seller', 'all_key', 'transaction', 'set_price',
  'news', 'reports', 'token_stats', 'payment_history', 'today_result', 'top_result'];

// Words that legitimately differ: the clone is renamed, and the reference data
// belongs to another customer.
const IGNORE = new Set([
  'cockroach', 'cockrouch', 'galaxy', 'ok', 'okrob', 'demo', 'sample', 'login', 'password',
  'please', 'input', 'data', 'format', 'click', 'here', 'page', 'found', 'today', 'new'
]);

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, ' ').replace(/&nbsp;/g, ' ').replace(/&rarr;/g, ' ')
    .replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    // Any remaining named entity is a glyph, not a word: &times; in the flash
    // alert's close button, &hellip;, &copy;. Dropping them keeps the comparer
    // from reporting the entity's *name* as ours-only text.
    .replace(/&[a-z][a-z0-9]{1,10};/gi, ' ')
    .replace(/&#\d+;/g, ' ');
}

function tokens(html) {
  const out = new Set();
  for (let raw of visibleText(html).split(/\s+/)) {
    // Math-bold letters map back to ASCII so both sides can be compared.
    let t = '';
    for (const ch of raw) {
      const c = ch.codePointAt(0);
      if (c >= 0x1D400 && c <= 0x1D41B) t += String.fromCharCode(c - 0x1D400 + 65);
      else if (c >= 0x1D41C && c <= 0x1D437) t += String.fromCharCode(c - 0x1D41C + 97);
      else if (c >= 0x1D438 && c <= 0x1D451) t += String.fromCharCode(c - 0x1D438 + 97);
      else if (c >= 0x1D46C && c <= 0x1D485) t += String.fromCharCode(c - 0x1D46C + 97);
      else t += ch;
    }
    raw = t.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
    if (!raw || raw.length < 2) continue;
    if (IGNORE.has(raw)) continue;
    // Pure data: numbers, dates, currency, ids, key names, usernames, ips, macs.
    if (/^[\d.,:%₹-]+$/.test(raw)) continue;
    if (/^[a-z]{6,}$/.test(raw) && /^[A-Z0-9]+$/.test(raw.toUpperCase()) && /[_0-9]/.test(raw)) continue;
    if (/^\d{4}\w/.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

// Structure = the controls on the page, independent of their contents.
// Form actions are compared after dropping the PHP-isms the reference carries
// ("./x.php"), because our build is Node and would be broken by keeping them.
function normAction(a) {
  return String(a).replace(/^\.?\//, '').replace(/\.php$/, '');
}

function structure(html) {
  const forms = [...html.matchAll(/<form[^>]*action="([^"]*)"[^>]*>/g)].map(m => normAction(m[1]));
  const inputs = [...html.matchAll(/<input[^>]*name="([^"]*)"[^>]*>/g)].map(m => m[1]);
  const selects = [...html.matchAll(/<select[^>]*name="([^"]*)"[^>]*>/g)].map(m => m[1]);
  const ths = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m =>
    m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  // Ordered, not a set: the reference loads page scripts in a specific place and
  // a duplicated or reordered tag is a real difference. The reference pulls two
  // libraries from jsdelivr while this build vendors them, so only the filename
  // is compared.
  const lib = url => url.startsWith('https://') ? path.basename(url.split('?')[0]) : path.basename(url);
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]*)"/g)].map(m => lib(m[1]));
  const css = [...html.matchAll(/<link[^>]*href="([^"]*)"[^>]*>/g)].map(m =>
    m[1].split('?')[0].split('/').pop());
  return { forms, inputs, selects, ths, scripts, css };
}

function ours(page) {
  const jar = path.join(T, 'cmp_admin.txt');
  // Sessions live in memory, so a restarted server invalidates an old jar;
  // logging in each run costs one request and keeps the comparison honest.
  execFileSync('curl', ['-s', '-c', jar, '-o', path.join(T, 'cmp_login.html'), '-X', 'POST',
    '-d', 'username=admin&password=admin123', B + '/login']);
  const file = path.join(T, 'cmp_' + page + '.html');
  const query = page === 'reports' ? '?from_date=2026-11-01&to_date=2026-11-07' : '';
  execFileSync('curl', ['-s', '-b', jar, '-o', file, B + '/' + page + query]);
  const io = fs.readFileSync(file, 'utf8');
  // A page that came back as the redirect stub means the session did not take;
  // comparing that would produce a wall of meaningless differences.
  if (/Redirecting to/.test(io)) throw new Error('not signed in while fetching /' + page);
  return io;
}

let bad = 0;
let assetBad = 0;
for (const page of PAGES) {
  const refFile = path.join(REF, page + '.html');
  if (!fs.existsSync(refFile)) { console.log('-- ' + page + ': no reference dump'); continue; }
  const ref = fs.readFileSync(refFile, 'utf8');
  const mine = ours(page);

  const a = tokens(ref);
  const b = tokens(mine);
  const missing = [...a].filter(t => !b.has(t));
  const extra = [...b].filter(t => !a.has(t));

  const sa = structure(ref);
  const sb = structure(mine);
  const sigDiff = [];
  for (const key of ['forms', 'inputs', 'selects', 'ths']) {
    const u = [...new Set(sa[key])].sort().join('|');
    const v = [...new Set(sb[key])].sort().join('|');
    if (u !== v) sigDiff.push(key + '\n      ref : ' + u + '\n      ours: ' + v);
  }
  const join = list => list.join(',');
  if (join(sa.scripts) !== join(sb.scripts)) {
    console.log('   scripts ref : ' + join(sa.scripts));
    console.log('   scripts ours: ' + join(sb.scripts));
    assetBad++;
  }
  if (join(sa.css) !== join(sb.css)) {
    console.log('   css ref : ' + join(sa.css));
    console.log('   css ours: ' + join(sb.css));
    assetBad++;
  }

  const clean = !missing.length && !extra.length && !sigDiff.length;
  console.log((clean ? 'ok   ' : 'DIFF ') + page +
    '  (text ' + b.size + '/' + a.size + ', controls ' + sb.inputs.length + '/' + sa.inputs.length + ')');
  if (missing.length) console.log('   text ref-only : ' + missing.slice(0, 12).join(', '));
  if (extra.length) console.log('   text ours-only: ' + extra.slice(0, 12).join(', '));
  sigDiff.forEach(d => console.log('   ' + d));
  if (!clean) bad++;
}

console.log('\npages with text/control differences: ' + bad + '/' + PAGES.length);
console.log('asset-list differences: ' + assetBad);
