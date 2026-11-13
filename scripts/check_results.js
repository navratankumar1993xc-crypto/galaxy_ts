'use strict';
// Only the runner's disposable database/files and a loopback server may be used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomInt, createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
let base, resultDir;
try {
  for (const name of ['GALAXY_DB', 'GALAXY_RESULT_DIR', 'RESULTS_ENCRYPTION_KEY', 'GALAXY_BASE']) assert.ok(process.env[name], name);
  const url = new URL(process.env.GALAXY_BASE);
  assert.ok(['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
  base = url.origin;
  const db = process.env.GALAXY_DB;
  resultDir = process.env.GALAXY_RESULT_DIR;
  for (const file of [db, resultDir]) {
    assert.ok(path.isAbsolute(file) && inside(os.tmpdir(), file) && !inside(path.resolve(__dirname, '..'), file));
  }
  // Resolve existing ancestors too: a symlink must not redirect us to owner data.
  const temp = fs.realpathSync(os.tmpdir()), dbReal = fs.realpathSync(db);
  const resultReal = fs.existsSync(resultDir) ? fs.realpathSync(resultDir) : path.join(fs.realpathSync(path.dirname(resultDir)), path.basename(resultDir));
  assert.ok(inside(temp, dbReal) && inside(temp, resultReal) && inside(path.dirname(dbReal), resultReal));
  for (const file of [dbReal, resultReal]) assert.ok(!inside(path.resolve(__dirname, '..'), file));
  assert.ok(fs.statSync(dbReal).isFile());
  const encoded = process.env.RESULTS_ENCRYPTION_KEY, bytes = Buffer.from(encoded, 'base64');
  assert.ok(bytes.length === 32 && bytes.toString('base64') === encoded);
} catch (_) {
  console.error('Refusing non-isolated result checks. Use: npm run check');
  process.exit(1);
}
// Never load dotenv or import the server; all imports below use explicit test paths.
const store = require('../db');
const keys = require('../src/queries/keys');
const tickets = require('../src/queries/tickets');
const crypto = require('../src/resultCrypto');
const validation = require('../src/resultValidation');
const nonce = randomUUID(), mac = '02:00:00:00:00:41', wrongMac = '02:00:00:00:00:42';
const marker = 'SYNTHETIC-RESULT-' + nonce, xss = '<script>check_' + nonce + '</script>';
const proxy = { scheme: 'socks5', host: 'proxy.example.test', port: 1080, username: xss, password: marker + '<>&"', domain: 'test.invalid' };
let key, token, controller, seller, passed = 0, failed = 0, serial = randomInt(1000000, 9000000);
const saved = {}, initialFiles = new Set(fs.existsSync(resultDir) ? fs.readdirSync(resultDir) : []);
function pngChunk(kind, bytes) {
  const data = Buffer.concat([Buffer.from(kind), bytes]), out = Buffer.alloc(bytes.length + 12);
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  out.writeUInt32BE(bytes.length); data.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr),
  pngChunk('tEXt', Buffer.from('Comment\0' + marker)), pngChunk('IDAT', deflateSync(Buffer.from([0, 50, 100, 150, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
function metadata(kind = 'direct') {
  return { version: 1, result_id: randomUUID(), pnr: '999' + (++serial), from: 'SYNTHETIC FROM', to: 'SYNTHETIC TO', train: xss,
    booking_time: today + 'T00:31:02.1234567+05:30', evidence: 'booking_response',
    connection: { kind, proxy: kind === 'proxy' ? proxy : null, booking_ip: kind === 'unknown' ? '' : '192.0.2.41',
      observed_ip: kind === 'proxy' ? '2001:db8::41' : '', ip_observed_at: kind === 'proxy' ? today + 'T00:32:03+05:30' : '',
      ip_source: kind === 'proxy' ? 'post_booking_probe' : 'unknown' } };
}
const request = (route, options = {}) => fetch(base + route, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
async function json(response, status) {
  assert.equal(response.status, status); assert.match(response.headers.get('content-type') || '', /^application\/json\b/i);
  return response.json();
}
async function login(username, password) {
  const res = await request('/login', { method: 'POST', body: new URLSearchParams({ username, password }) });
  assert.equal(res.status, 302); assert.equal(res.headers.get('location'), '/home'); await res.text();
  const cookie = res.headers.getSetCookie().map(s => s.split(';')[0]).join('; '); assert.ok(cookie); return cookie;
}
function upload(meta = metadata(), options = {}) {
  const body = new FormData();
  body.set('metadata', typeof meta === 'string' ? meta : JSON.stringify(meta));
  body.set('image', new Blob([options.image === undefined ? png : options.image], { type: options.mime || 'image/png' }), options.filename || 'synthetic.png');
  const auth = options.auth === undefined ? 'Bearer ' + token : options.auth;
  return request('/api/results', { method: 'POST', headers: auth ? { Authorization: auth } : {}, body });
}
function snapshot() {
  const files = fs.existsSync(resultDir) ? fs.readdirSync(resultDir).sort() : [];
  return { rows: store.all('SELECT * FROM tickets3 WHERE key_id = ? ORDER BY id', [key.key_name]),
    key: store.get('SELECT * FROM keys WHERE id = ?', [key.id]),
    files: files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(resultDir, file))).digest('hex')]) };
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok    ' + name); }
  catch (err) { failed++; console.error('  FAIL  ' + name); throw err; }
}
async function denied(name, meta, options = {}, status = 400) {
  await test(name, async () => {
    const before = snapshot(), data = await json(await upload(meta, options), status);
    assert.equal(data.success, false); assert.equal(data.id, undefined);
    for (const secret of [marker, token, key.key_name, resultDir, process.env.GALAXY_DB]) assert.ok(!JSON.stringify(data).includes(secret));
    assert.deepEqual(snapshot(), before, 'rejected request changed persisted state');
  });
}
async function main() {
  await test('legacy tickets migrate in memory, preserve rows, enforce identity uniqueness', () => {
    const db = new (require('node:sqlite').DatabaseSync)(':memory:');
    try {
      db.exec("CREATE TABLE tickets3 (id INTEGER PRIMARY KEY, pnr TEXT, img TEXT, tdate TEXT); INSERT INTO tickets3 VALUES(1,'9990000001','legacy.png','2001-01-01')");
      const upgrade = require('../db/migrate').upgrade; upgrade(db); assert.deepEqual(upgrade(db), []);
      const row = db.prepare('SELECT * FROM tickets3 WHERE id=1').get();
      assert.equal(row.pnr, '9990000001'); assert.equal(row.img, 'legacy.png'); assert.equal(row.tdate, '2001-01-01');
      for (const col of ['upload_identity', 'result_id', 'booking_time', 'uploaded_at', 'evidence', 'connection_kind', 'proxy_encrypted', 'observed_ip', 'ip_observed_at', 'ip_source', 'image_file', 'image_mime']) assert.equal(row[col], null);
      db.exec("INSERT INTO tickets3(id) VALUES(2); UPDATE tickets3 SET upload_identity='1:9990000001' WHERE id=1");
      assert.throws(() => db.exec("UPDATE tickets3 SET upload_identity='1:9990000001' WHERE id=2"), /UNIQUE/);
    } finally { db.close(); }
  });
  await test('isolated controller and seller logins', async () => {
    controller = await login('admin', 'admin123'); seller = await login('YOGISELL', 'demo123');
  });
  await test('synthetic licensed key gets MAC-bound result upload token', async () => {
    const owner = store.get("SELECT id FROM users WHERE username='admin' AND role='controller'"); assert.ok(owner);
    keys.generate({ owner, days: 30, hasPaid: 1, name: 'RESULTCHECK' + nonce }); key = keys.getByName('RESULTCHECK' + nonce);
    const data = await json(await request('/api/license/validate', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(Date.now() + ':' + key.key_name).toString('base64') },
      body: JSON.stringify({ userName: key.key_name, macAddress: mac }) }), 200);
    assert.equal(data.success, true); token = data.resultUploadToken; assert.ok(token);
    const claims = crypto.verifyToken(token); assert.equal(claims.keyId, key.id); assert.equal(claims.mac, mac);
  });
  for (const kind of ['direct', 'proxy', 'unknown']) await test(kind + ' upload: encryption, India date, no connection-state leakage', async () => {
    const meta = metadata(kind), data = await json(await upload(meta, { filename: '../../' + nonce + '\\escape.png' }), 201);
    assert.equal(data.success, true); assert.ok(Number.isSafeInteger(data.id)); const row = tickets.get(data.id); saved[kind] = { meta, row };
    assert.equal(row.upload_identity, `${key.id}:${meta.pnr}`); assert.equal(row.result_id, meta.result_id);
    assert.equal(row.booking_time, meta.booking_time); assert.equal(row.tdate, today); assert.ok(Number.isFinite(Date.parse(row.uploaded_at)));
    assert.equal(row.mac, mac); assert.equal(row.evidence, meta.evidence); assert.equal(row.connection_kind, kind);
    for (const [column, field] of [['ip', 'booking_ip'], ['observed_ip', 'observed_ip'], ['ip_observed_at', 'ip_observed_at'], ['ip_source', 'ip_source']]) assert.equal(row[column], meta.connection[field]);
    assert.match(row.image_file, /^[a-zA-Z0-9-]+\.bin$/); assert.equal(row.img, ''); assert.equal(row.image_mime, 'image/png');
    const image = fs.readFileSync(path.join(resultDir, row.image_file));
    const sealedProxy = typeof row.proxy_encrypted === 'string' ? Buffer.from(row.proxy_encrypted, 'base64') : Buffer.from(row.proxy_encrypted);
    assert.deepEqual(crypto.open(image, 'image', row.upload_identity), png);
    assert.deepEqual(JSON.parse(crypto.open(sealedProxy, 'proxy', row.upload_identity)), meta.connection.proxy);
    assert.ok(!image.includes(Buffer.from(marker))); assert.ok(!sealedProxy.includes(Buffer.from(marker)));
    assert.ok(!JSON.stringify(row).includes(marker)); assert.ok(!sealedProxy.includes(Buffer.from(xss))); assert.throws(() => crypto.open(image, 'image', row.upload_identity + 'wrong'));
    const tampered = Buffer.from(image); tampered[tampered.length - 1] ^= 1; assert.throws(() => crypto.open(tampered, 'image', row.upload_identity));
  });
  await test('duplicate PNR with fresh result ID returns 200 and changes nothing', async () => {
    const before = snapshot(), data = await json(await upload({ ...metadata('unknown'), pnr: saved.proxy.meta.pnr, train: 'CHANGED' }), 200);
    assert.equal(data.success, true); assert.equal(data.id, saved.proxy.row.id); assert.deepEqual(snapshot(), before);
  });
  await test('concurrent duplicate writes one row and one encrypted file', async () => {
    const meta = metadata(), before = snapshot(), responses = await Promise.all([upload(meta), upload({ ...meta, result_id: randomUUID() })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
    const data = await Promise.all(responses.map(r => json(r, r.status))); assert.ok(data.every(d => d.success)); assert.equal(data[0].id, data[1].id);
    const after = snapshot(); assert.equal(after.rows.length, before.rows.length + 1); assert.equal(after.files.length, before.files.length + 1);
    assert.equal(store.scalar('SELECT COUNT(*) FROM tickets3 WHERE upload_identity=?', [`${key.id}:${meta.pnr}`]), 1);
  });
  for (const [name, auth] of [['missing token', ''], ['malformed token', 'Bearer invalid'], ['wrong auth scheme', 'Basic ' + token],
    ['tampered token', 'Bearer ' + token.replace(/\.[A-Za-z0-9_-]/, s => s === '.A' ? '.B' : '.A')],
    ['expired token', 'Bearer ' + crypto.issueToken(key, mac, Date.now() - 86401000)], ['wrong MAC token', 'Bearer ' + crypto.issueToken(key, wrongMac)]]) await denied(name, metadata(), { auth }, 401);
  for (const [name, change, restore] of [['reassigned MAC', () => keys.setMac(key.id, wrongMac), () => keys.setMac(key.id, mac)],
    ['reset MAC', () => keys.setMac(key.id, ''), () => keys.setMac(key.id, mac)], ['deactivated key', () => keys.setStatus(key.id, 'deactive'), () => keys.setStatus(key.id, 'active')],
    ['expired key', () => store.run("UPDATE keys SET expire_date='2000-01-01 00:00:00' WHERE id=?", [key.id]), () => store.run('UPDATE keys SET expire_date=? WHERE id=?', [key.expire_date, key.id])]]) {
    change(); try { await denied(name, metadata(), {}, 401); } finally { restore(); }
  }
  for (const [name, mutate] of [['missing PNR', m => delete m.pnr], ['placeholder PNR', m => m.pnr = '0000000000'], ['invalid PNR', m => m.pnr = 'NOT-A-PNR'],
    ['missing booking timestamp', m => delete m.booking_time], ['impossible timestamp', m => m.booking_time = '2026-02-30T00:00:00Z'],
    ['invalid IP', m => m.connection.booking_ip = '999.0.0.1'], ['invalid observed IP', m => m.connection.observed_ip = 'not-an-ip'],
    ['missing observation time', m => m.connection.ip_observed_at = ''], ['observation before booking', m => m.connection.ip_observed_at = '2000-01-01T00:00:00Z'],
    ['direct with proxy credentials', m => m.connection.kind = 'direct'], ['proxy without credentials', m => m.connection.proxy = null],
    ['invalid version', m => m.version = 2], ['invalid result UUID', m => m.result_id = '../escape'], ['unexpected metadata field', m => m.extra = marker]]) {
    const meta = metadata('proxy'); mutate(meta); await denied(name, meta);
  }
  await denied('malformed metadata JSON', '{');
  await denied('oversized metadata', ' '.repeat(validation.MAX_FIELD + 1), {}, 413);
  for (const [name, image, mime, status] of [['empty image', Buffer.alloc(0), 'image/png', 400], ['oversized image', Buffer.alloc(validation.MAX_IMAGE + 1), 'image/png', 413],
    ['wrong MIME', png, 'image/jpeg', 400], ['unsupported MIME', png, 'image/svg+xml', 400], ['fake PNG', Buffer.from('<svg/>'), 'image/png', 400],
    ['truncated PNG', png.subarray(0, -5), 'image/png', 400], ['truncated JPEG', Buffer.from('ffd8ffe000104a46494600', 'hex'), 'image/jpeg', 400]]) await denied(name, metadata(), { image, mime }, status);
  await test('truncated multipart returns JSON without crashing or persisting state', async () => {
    const before = snapshot(), boundary = 'check-' + nonce;
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata())}\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`;
    const data = await json(await request('/api/results', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body }), 400);
    assert.equal(data.success, false); assert.deepEqual(snapshot(), before); assert.equal((await request('/login')).status, 200);
  });
  await test('controller image decrypts; missing image returns JSON', async () => {
    const res = await request('/result_image/' + saved.proxy.row.id, { headers: { Cookie: controller } });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /^image\/png/); assert.match(res.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    assert.equal((await json(await request('/result_image/0', { headers: { Cookie: controller } }), 404)).success, false);
  });
  await test('controller UI escapes synthetic metadata and proxy credentials', async () => {
    const res = await request('/today_result', { headers: { Cookie: controller } }); assert.equal(res.status, 200);
    const html = await res.text(); assert.ok(html.includes(saved.proxy.meta.pnr)); assert.ok(html.includes(xss.replaceAll('<', '&lt;').replaceAll('>', '&gt;'))); assert.ok(!html.includes(xss));
    assert.ok(html.includes(marker + '&lt;&gt;&amp;')); assert.ok(html.includes(saved.proxy.meta.booking_time));
    const top = await request('/top_result', { headers: { Cookie: controller } }); assert.equal(top.status, 200);
    const gallery = await top.text(); assert.ok(gallery.includes('/result_image/' + saved.proxy.row.id));
    for (const detail of [saved.proxy.meta.pnr, saved.proxy.meta.booking_time, 'Route:', 'Train:', 'Booking time (as reported):']) assert.ok(!gallery.includes(detail), 'image gallery must not show booking details');
  });
  for (const route of ['/today_result', '/top_result', '/result_image/' + saved.proxy.row.id, '/uploads/check-' + nonce + '.png']) await test('controller-only access: ' + route.split('/')[1], async () => {
    const deniedSeller = await request(route, { headers: { Cookie: seller } }); assert.equal(deniedSeller.status, 403); assert.ok(!(await deniedSeller.text()).includes(marker));
    const anonymous = await request(route); assert.ok([302, 401, 403].includes(anonymous.status)); await anonymous.text();
  });
  await test('controller legacy uploads route remains behind access control', async () => {
    const res = await request('/uploads/check-' + nonce + '.png', { headers: { Cookie: controller } }); assert.equal(res.status, 404); await res.text();
  });
  keys.remove(key.id); await denied('deleted key token', metadata(), {}, 401);
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  try {
    if (key) {
      const rows = store.all('SELECT image_file FROM tickets3 WHERE key_id=?', [key.key_name]);
      for (const { image_file: file } of rows) if (file && !initialFiles.has(file) && /^[a-zA-Z0-9-]+\.bin$/.test(file)) fs.rmSync(path.join(resultDir, file), { force: true });
      store.run('DELETE FROM tickets3 WHERE key_id=?', [key.key_name]); keys.remove(key.id);
    } // The runner also removes the entire private temp tree, including any orphan.
  } catch (err) { console.error('Result check cleanup failed:', err.message); process.exitCode = 1; }
  console.log(`Result checks: ${passed} passed, ${failed} failed (fail-fast).`);
});
