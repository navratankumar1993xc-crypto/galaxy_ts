'use strict';
// ---------------------------------------------------------------------------
// The check runner. Every suite writes and deletes rows, so none of them may
// ever touch data/galaxy.db — that file is the owner's working data. This
// runner builds a throwaway database in a temp dir, seeds the demo chain into
// it, starts a private server on port 3199 against it, runs the suites against
// that server, and then kills the server and deletes the temp dir.
//
//   npm run check
//
// The suites themselves refuse to start without GALAXY_DB, so running one by
// hand against the live panel is impossible too.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.GALAXY_CHECK_PORT || 3199);
const BASE = 'http://localhost:' + PORT;
const SUITES = [
  'check_demo.js',
  'check_keypay.js',
  'check_success_details.js',
  'check_money.js',
  'check_pages.js',
  'check_directlogin.js',
  'check_license.js',
  'check_results.js'
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-check-'));
let server = null;
const env = Object.assign({}, process.env, {
  GALAXY_DB: path.join(tmp, 'check.db'),
  GALAXY_RESULT_DIR: path.join(tmp, 'results'),
  RESULTS_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('base64'),
  PORT: String(PORT),
  GALAXY_BASE: BASE
});

function run(args) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', function (code) {
      if (code === 0) resolve();
      else reject(new Error(args.join(' ') + ' exited ' + code));
    });
  });
}

function cleanup(server) {
  return new Promise(function (resolve) {
    if (!server || server.exitCode !== null) return resolve();
    server.on('exit', resolve);
    server.kill();
    // Windows can hold the WAL open for a moment after the kill.
    setTimeout(function () { server.kill('SIGKILL'); resolve(); }, 3000);
  });
}

async function main() {
  console.log('Throwaway database: ' + env.GALAXY_DB);
  await run(['db/seed.js', '--demo']);
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'inherit' });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(BASE + '/login');
      if (res.ok) break;
    } catch (err) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('the private check server never came up');
    await new Promise(r => setTimeout(r, 300));
  }

  let failed = 0;
  for (const suite of SUITES) {
    console.log('\n######## ' + suite + ' ########');
    try {
      await run(['scripts/' + suite]);
    } catch (err) {
      failed++;
      console.error('SUITE FAILED: ' + suite);
    }
  }

  await cleanup(server);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nThrowaway database deleted. ' + (failed ? failed + ' suite(s) FAILED' : 'All suites green'));
  process.exit(failed ? 1 : 0);
}

main().catch(async function (err) {
  console.error(err);
  await cleanup(server);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});