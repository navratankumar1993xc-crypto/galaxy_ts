'use strict';
const { TextDecoder } = require('util');
const { MAX_IMAGE, MAX_FIELD } = require('./resultValidation');
const MAX_BODY = MAX_IMAGE + MAX_FIELD + 8192;
function failure(code, status = 400) { return Object.assign(new Error(code), { code, status }); }

// This deliberately does not feed untrusted streams into installed multer 1.x /
// busboy 0.x (malformed multipart can emit unhandled stream errors there).
// The result wire protocol is just two bounded parts, not a general form parser.
function parse(body, boundary) {
  const delimiter = Buffer.from('--' + boundary);
  const separator = Buffer.from('\r\n--' + boundary);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) throw failure('INVALID_MULTIPART');
  let offset = delimiter.length, count = 0;
  const parts = Object.create(null);
  for (;;) {
    if (body.subarray(offset, offset + 2).toString() === '--') {
      const rest = body.subarray(offset + 2).toString();
      if (rest !== '' && rest !== '\r\n') throw failure('INVALID_MULTIPART');
      break;
    }
    if (++count > 2) throw failure('TOO_MANY_PARTS');
    if (body.subarray(offset, offset + 2).toString() !== '\r\n') throw failure('INVALID_MULTIPART');
    offset += 2;
    const headerEnd = body.indexOf('\r\n\r\n', offset);
    if (headerEnd < offset || headerEnd - offset > 2048) throw failure('INVALID_MULTIPART');
    const headers = Object.create(null);
    for (const line of body.toString('latin1', offset, headerEnd).split('\r\n')) {
      const match = /^([a-zA-Z-]+):[ \t]*([^\r\n]+)$/.exec(line);
      if (!match || headers[match[1].toLowerCase()]) throw failure('INVALID_MULTIPART');
      headers[match[1].toLowerCase()] = match[2];
    }
    const disposition = /^form-data;\s*name="(metadata|image)"(?:;\s*filename="[^"\r\n]*")?$/i.exec(headers['content-disposition'] || '');
    if (!disposition) throw failure('INVALID_MULTIPART');
    const name = disposition[1];
    const file = /;\s*filename=/i.test(disposition[0]);
    if (parts[name] || (name === 'image') !== file || headers['content-transfer-encoding']) throw failure('INVALID_MULTIPART');
    offset = headerEnd + 4;
    let end = body.indexOf(separator, offset);
    // A boundary-like sequence inside image data is not a delimiter unless its
    // suffix is CRLF or --; no interpretation of the original filename.
    while (end !== -1 && !['\r\n', '--'].includes(body.subarray(end + separator.length, end + separator.length + 2).toString())) {
      end = body.indexOf(separator, end + separator.length);
    }
    if (end === -1) throw failure('INVALID_MULTIPART');
    const bytes = body.subarray(offset, end);
    if (bytes.length > (file ? MAX_IMAGE : MAX_FIELD)) throw failure(file ? 'IMAGE_TOO_LARGE' : 'METADATA_TOO_LARGE', 413);
    parts[name] = { bytes, mime: headers['content-type'] || '' };
    offset = end + separator.length;
  }
  if (count !== 2 || !parts.metadata || !parts.image) throw failure('MISSING_RESULT_PARTS');
  let metadata;
  try { metadata = new TextDecoder('utf-8', { fatal: true }).decode(parts.metadata.bytes); }
  catch (_) { throw failure('INVALID_RESULT_METADATA'); }
  return { metadata, image: parts.image.bytes, mime: parts.image.mime };
}
function read(req) {
  return new Promise((resolve, reject) => {
    const match = /^multipart\/form-data\s*;\s*boundary=(?:"([a-zA-Z0-9'()+_,./:=? -]{1,70})"|([a-zA-Z0-9'()+_,./:=?-]{1,70}))\s*$/i.exec(req.headers['content-type'] || '');
    if (!match || req.headers['content-encoding']) {
      req.resume();
      return reject(failure('INVALID_MULTIPART'));
    }
    const chunks = [];
    let size = 0, finished = false;
    function fail(err) {
      if (finished) return;
      finished = true;
      chunks.length = 0;
      reject(err);
    }
    req.on('error', () => fail(failure('INVALID_MULTIPART')));
    req.on('aborted', () => fail(failure('INVALID_MULTIPART')));
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY) return fail(failure('RESULT_TOO_LARGE', 413));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      try { resolve(parse(Buffer.concat(chunks), match[1] || match[2])); }
      catch (err) { reject(err); }
    });
    if (Number(req.headers['content-length']) > MAX_BODY) fail(failure('RESULT_TOO_LARGE', 413));
  });
}
module.exports = { read };
