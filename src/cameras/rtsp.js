'use strict';

// RTSP `DESCRIBE` zu einer Kamera im LAN (Test einer RTSP-Adresse, Codec aus
// dem SDP). Nur die geprüfte IPv4-Adresse, Antwort ≤ 64 KB, 4 s Verbindung,
// 8 s gesamt, Anmeldung per Digest (oder Basic, wenn nur das angeboten wird).

const net = require('node:net');
const { authFor } = require('./http');

const MAX = 64 * 1024;

class RtspError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function exchange({ host, port, request, timeoutMs = 8000, connectMs = 4000 }) {
  return new Promise((resolve, reject) => {
    if (!net.isIPv4(host)) { reject(new RtspError('not_allowed')); return; }
    let buf = Buffer.alloc(0);
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t1); clearTimeout(t2); sock.destroy(); fn(v); };
    const t1 = setTimeout(() => finish(reject, new RtspError('unreachable', 'the camera does not answer')), connectMs);
    const t2 = setTimeout(() => finish(reject, new RtspError('timeout', 'the camera did not answer in time')), timeoutMs);
    sock.once('connect', () => { clearTimeout(t1); sock.write(request); });
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > MAX) { finish(reject, new RtspError('too_large')); return; }
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.slice(0, end).toString('latin1');
      const lines = head.split('\r\n');
      const m = /^RTSP\/1\.0 (\d{3})/.exec(lines[0] || '');
      if (!m) { finish(reject, new RtspError('no_stream', 'no RTSP answer')); return; }
      const headers = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i <= 0) continue;
        const k = l.slice(0, i).trim().toLowerCase();
        const v = l.slice(i + 1).trim();
        headers[k] = headers[k] ? [].concat(headers[k], v) : v;
      }
      const len = Number(headers['content-length'] || 0);
      if (len > MAX) { finish(reject, new RtspError('too_large')); return; }
      if (buf.length - end - 4 < len) return;
      finish(resolve, { status: Number(m[1]), headers, body: buf.slice(end + 4, end + 4 + len).toString('utf8') });
    });
    sock.on('error', () => finish(reject, new RtspError('unreachable', 'the camera does not answer')));
  });
}

/** SDP → { codec: h264|h265|other|null, audio: boolean } */
function sdpInfo(sdp) {
  let codec = null;
  let audio = false;
  let media = null;
  for (const l of String(sdp || '').split(/\r?\n/)) {
    if (l.startsWith('m=')) media = l.slice(2).split(' ')[0];
    if (media === 'audio' && l.startsWith('m=')) audio = true;
    const m = /^a=rtpmap:\d+ ([A-Za-z0-9-]+)\//.exec(l);
    if (m && media === 'video' && !codec) {
      const c = m[1].toUpperCase();
      codec = c === 'H264' ? 'h264' : (c === 'H265' || c === 'HEVC' ? 'h265' : 'other');
    }
  }
  return { codec, audio };
}

/** DESCRIBE rtsp://host:port/path → { codec, audio }; wirft RtspError (auth_failed, no_stream, unreachable …). */
async function describe({ host, port, path, user, password }) {
  const url = `rtsp://${host}:${port}${path}`;
  const req = (cseq, auth) => `DESCRIBE ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\nUser-Agent: GateControl-Gateway\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`;
  let r = await exchange({ host, port, request: req(1, null) });
  if (r.status === 401 && user) {
    const auth = authFor(r.headers['www-authenticate'], { user, password: password || '', method: 'DESCRIBE', uri: url });
    if (!auth) throw new RtspError('auth_failed', 'unsupported RTSP authentication');
    r = await exchange({ host, port, request: req(2, auth) });
  }
  if (r.status === 401) throw new RtspError('auth_failed', 'the camera refused the user or password');
  if (r.status >= 300 && r.status < 400) throw new RtspError('no_stream', 'the camera answered with a redirect');
  if (r.status !== 200) throw new RtspError('no_stream', 'RTSP ' + r.status);
  const info = sdpInfo(r.body);
  if (!info.codec) throw new RtspError('no_stream', 'no video in the stream');
  return info;
}

module.exports = { describe, sdpInfo, RtspError };
