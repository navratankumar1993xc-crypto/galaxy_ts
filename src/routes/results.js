'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const cfg = require('../config');
const tickets = require('../queries/tickets');
const keys = require('../queries/keys');
const prices = require('../queries/prices');
const resultCrypto = require('../resultCrypto');
const validation = require('../resultValidation');
const multipart = require('../resultMultipart');

function failure(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function currentKey(claims) {
  if (!claims) return null;
  keys.enforceCascades(prices.all());
  const key = keys.get(claims.keyId);
  // SQLite stores local wall-clock timestamps. Do not use rounded left_days:
  // a recently expired key can still have a displayed value of "-0".
  const expiry = key && new Date(String(key.expire_date || '').replace(' ', 'T')).getTime();
  return key && Number(key.id) === claims.keyId && key.key_name === claims.keyName &&
    key.mac === claims.mac && key.status === 'active' && expiry > Date.now() ? key : null;
}

// ------------------------------------------------------------- /api/results
async function apiResults(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!resultCrypto.enabled) {
    req.resume();
    return res.status(503).json({ success: false, message: 'Result uploads are unavailable.', code: resultCrypto.configurationError });
  }
  try {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const token = bearer ? bearer[1] : '';
    let key = currentKey(resultCrypto.verifyToken(token));
    if (!key) {
      req.resume();
      return failure(res, 401, 'Result upload authorization failed.');
    }

    let parts;
    try {
      parts = await multipart.read(req);
    } catch (err) {
      if (err.status === 413) return failure(res, 413, 'Result upload exceeds the size limit.');
      if (err.status === 400) return failure(res, 400, 'Invalid result upload.');
      throw err;
    }
    let metadata;
    try {
      metadata = validation.metadata(parts.metadata);
    } catch (err) {
      if (err.message === 'INVALID_RESULT_METADATA') return failure(res, 400, 'Invalid result metadata.');
      throw err;
    }
    const mime = validation.image(parts.image, parts.mime);
    if (!mime) return failure(res, 400, 'Invalid result image.');

    // The key or token may have been revoked/expired while the body arrived.
    key = currentKey(resultCrypto.verifyToken(token));
    if (!key) return failure(res, 401, 'Result upload authorization failed.');
    const identity = `${key.id}:${metadata.pnr}`;
    // Keep deduplication, exclusive file creation and DB insertion synchronous.
    // No request can interleave another save on this process after this lookup.
    const existing = tickets.byIdentity(identity);
    if (existing) return res.status(200).json({ success: true, id: existing.id, duplicate: true });

    const connection = metadata.connection;
    const proxyEncrypted = resultCrypto.seal(Buffer.from(JSON.stringify(connection.proxy)), 'proxy', identity).toString('base64');
    const image = resultCrypto.seal(parts.image, 'image', identity);
    const imageFile = randomUUID() + '.bin';
    const filename = path.join(cfg.RESULT_DIR, imageFile);
    fs.mkdirSync(cfg.RESULT_DIR, { recursive: true });
    fs.writeFileSync(filename, image, { flag: 'wx', mode: 0o600 });
    let id;
    try {
      id = tickets.addResult({
        src: metadata.from,
        dest: metadata.to,
        train: metadata.train,
        pay_mode: metadata.pay_mode,
        mac: key.mac,
        key_id: key.key_name,
        ip: connection.booking_ip,
        pnr: metadata.pnr,
        tdate: validation.indiaDate(metadata.booking_time),
        upload_identity: identity,
        result_id: metadata.result_id,
        booking_time: metadata.booking_time,
        uploaded_at: new Date().toISOString(),
        evidence: metadata.evidence,
        connection_kind: connection.kind,
        proxy_encrypted: proxyEncrypted,
        observed_ip: connection.observed_ip,
        ip_observed_at: connection.ip_observed_at,
        ip_source: connection.ip_source,
        image_file: imageFile,
        image_mime: mime
      });
    } catch (err) {
      // Only this request's successfully created file is eligible for cleanup.
      try { fs.unlinkSync(filename); } catch (_) { /* Do not log private result data. */ }
      throw err;
    }
    return res.status(201).json({ success: true, id });
  } catch (_) {
    return failure(res, 500, 'Something went wrong on the server.');
  }
}

// --------------------------------------------------------- /result_image/:id
function resultImage(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
    return failure(res, 404, 'Result image not found.');
  }
  if (!resultCrypto.enabled) return failure(res, 503, 'Result images are unavailable.');
  try {
    const ticket = tickets.get(Number(req.params.id));
    if (!ticket || !ticket.upload_identity || typeof ticket.image_file !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/i.test(ticket.image_file) ||
        !['image/png', 'image/jpeg'].includes(ticket.image_mime)) {
      return failure(res, 404, 'Result image not found.');
    }
    const encrypted = fs.readFileSync(path.join(cfg.RESULT_DIR, ticket.image_file));
    const image = resultCrypto.open(encrypted, 'image', ticket.upload_identity);
    return res.type(ticket.image_mime).send(image);
  } catch (err) {
    if (err.code === 'ENOENT') return failure(res, 404, 'Result image not found.');
    return failure(res, 500, 'Something went wrong on the server.');
  }
}

// ------------------------------------------------------------ /today_result
function todayResult(req, res) {
  res.set('Cache-Control', 'no-store');
  const rows = tickets.today().map(function (t) {
    t.proxy = null;
    t.proxyUnavailable = false;
    if (t.proxy_encrypted) {
      try {
        t.proxy = JSON.parse(resultCrypto.open(Buffer.from(t.proxy_encrypted, 'base64'), 'proxy', t.upload_identity).toString('utf8'));
      } catch (_) {
        t.proxyUnavailable = true;
      }
    }
    return t;
  });
  res.render('controller/today_result', { rows });
}

// -------------------------------------------------------------- /top_result
function topResult(req, res) {
  res.set('Cache-Control', 'no-store');
  res.render('controller/top_result', { images: tickets.todayImages() });
}

module.exports = { apiResults, resultImage, todayResult, topResult };
