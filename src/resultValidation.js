'use strict';
const net = require('net');
const zlib = require('zlib');
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_FIELD = 64 * 1024;
function invalid() { throw new Error('INVALID_RESULT_METADATA'); }
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !allowed.includes(k))) invalid();
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid();
  return value;
}
function timestamp(value, optional = false) {
  if (optional && value === '') return value;
  text(value, 40, true);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) invalid();
  const [, year, month, day, hour, minute, second, , zoneHour, zoneMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      Number(zoneHour || 0) > 14 || Number(zoneMinute || 0) > 59 ||
      (Number(zoneHour) === 14 && Number(zoneMinute) !== 0) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function indiaDate(value = Date.now()) {
  return new Date(new Date(value).getTime() + 330 * 60000).toISOString().slice(0, 10);
}
function ip(value) {
  text(value, 45);
  if (value && !net.isIP(value)) invalid();
  return value;
}
function metadata(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { invalid(); }
  object(value, ['version', 'result_id', 'pnr', 'from', 'to', 'train', 'booking_time', 'pay_mode', 'evidence', 'connection']);
  if (value.version !== 1 || typeof value.result_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.result_id) ||
      typeof value.pnr !== 'string' || !/^\d{10}$/.test(value.pnr) || value.pnr === '0000000000') invalid();
  text(value.from, 128, true); text(value.to, 128, true); text(value.train, 200, true);
  timestamp(value.booking_time);
  value.pay_mode = value.pay_mode === undefined ? '' : text(value.pay_mode, 64);
  if (!['booking_response', 'unknown'].includes(value.evidence)) invalid();
  const c = value.connection;
  object(c, ['kind', 'proxy', 'booking_ip', 'observed_ip', 'ip_observed_at', 'ip_source']);
  if (!['direct', 'proxy', 'unknown'].includes(c.kind)) invalid();
  if (c.proxy !== null) {
    object(c.proxy, ['scheme', 'host', 'port', 'username', 'password', 'domain']);
    const p = c.proxy;
    if (c.kind === 'direct' || !['http', 'https', 'socks4', 'socks5'].includes(p.scheme)) invalid();
    text(p.host, 253, true);
    // Do not resolve hosts or contact proxies; an egress address may be unknown.
    if (!net.isIP(p.host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(p.host)) invalid();
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) invalid();
    text(p.username, 512); text(p.password, 1024); text(p.domain, 256);
  } else if (c.kind === 'proxy') invalid();
  ip(c.booking_ip); ip(c.observed_ip); timestamp(c.ip_observed_at, true);
  if (!['unknown', 'post_booking_probe'].includes(c.ip_source)) invalid();
  if (c.ip_source === 'unknown' && (c.observed_ip || c.ip_observed_at)) invalid();
  if (c.ip_source === 'post_booking_probe' && (!c.observed_ip || !c.ip_observed_at ||
      Date.parse(c.ip_observed_at) < Date.parse(value.booking_time))) invalid();
  return value;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dimensions(w, h) { return w > 0 && h > 0 && w <= 20000 && h <= 20000 && w * h <= 25000000; }
function png(data) {
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8, header = false, ended = false, width, height, depth, color, interlace;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > data.length) return false;
    const kind = data.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(kind) || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return false;
    if (!header && kind !== 'IHDR') return false;
    if (kind === 'IHDR') {
      if (header || size !== 13) return false;
      width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12);
      depth = data[offset + 16]; color = data[offset + 17]; interlace = data[offset + 20];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!dimensions(width, height) || !(depths[color] || []).includes(depth) ||
          data[offset + 18] !== 0 || data[offset + 19] !== 0 || interlace > 1) return false;
      header = true;
    }
    if (kind === 'IDAT') compressed.push(data.subarray(offset + 8, end - 4));
    if (kind === 'IEND') {
      ended = size === 0 && end === data.length;
      break;
    }
    offset = end;
  }
  if (!ended || !compressed.length) return false;
  try {
    const raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: 64 * 1024 * 1024 });
    if (!raw.length) return false;
    if (!interlace) {
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      const stride = Math.ceil(width * channels * depth / 8) + 1;
      if (raw.length !== stride * height) return false;
      for (let i = 0; i < raw.length; i += stride) if (raw[i] > 4) return false;
    }
    return true;
  } catch (_) { return false; }
}
function jpeg(data) {
  if (data.length < 12 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) return false;
  let offset = 2, frame = false, scan = false, entropy = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) return frame && scan && entropy && offset === data.length;
    if (marker === undefined || marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > data.length) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 11 || !dimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)) ||
          length !== 8 + 3 * data[offset + 7]) return false;
      frame = true;
    }
    if (marker === 0xda) {
      if (!frame || length < 6 || length !== 6 + 2 * data[offset + 2]) return false;
      scan = true;
      offset += length;
      const start = offset;
      while (offset < data.length) {
        if (data[offset] !== 0xff) { offset++; continue; }
        const next = data[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
      if (offset > start) entropy = true;
    } else offset += length;
  }
  return false;
}
function image(data, declaredMime) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_IMAGE) return null;
  if (declaredMime === 'image/png' && png(data)) return 'image/png';
  if (declaredMime === 'image/jpeg' && jpeg(data)) return 'image/jpeg';
  return null;
}
module.exports = { metadata, image, indiaDate, MAX_IMAGE, MAX_FIELD };
