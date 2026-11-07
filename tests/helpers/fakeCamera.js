'use strict';

// Eine Test-Kamera mit ONVIF (SOAP 1.2, WS-UsernameToken), Snapshot per
// HTTP-Digest und PullPoint-Ereignissen – genug für tests/cameras.test.js.
// Nennt in ihren Antworten absichtlich eine FREMDE Adresse (203.0.113.9):
// das Gateway darf nur Port und Pfad übernehmen. Mit `tls: { key, cert }`
// spricht sie HTTPS (selbst signiert) und nennt https-Adressen.

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);

function soapOk(body) {
  return `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="x" xmlns:trt="y" xmlns:tt="z" xmlns:tev="e" xmlns:wsnt="n" xmlns:wsa5="a" xmlns:tns1="t">`
    + `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}
const FAULT = soapOk('<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code></SOAP-ENV:Fault>');

function checkToken(body, user, password) {
  const u = /<wsse:Username>([^<]*)<\/wsse:Username>/.exec(body);
  const p = /<wsse:Password[^>]*>([^<]*)<\/wsse:Password>/.exec(body);
  const n = /<wsse:Nonce[^>]*>([^<]*)<\/wsse:Nonce>/.exec(body);
  const c = /<wsu:Created>([^<]*)<\/wsu:Created>/.exec(body);
  if (!u || !p || !n || !c || u[1] !== user) return false;
  const want = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(n[1], 'base64'), Buffer.from(c[1]), Buffer.from(password)])).digest('base64');
  return want === p[1];
}

function checkDigest(h, user, password, method, realm, nonce) {
  if (!h || !h.startsWith('Digest ')) return false;
  const p = {};
  for (const part of h.slice(7).split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    p[part.slice(0, i).trim()] = part.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  const H = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = H(`${user}:${realm}:${password}`);
  const ha2 = H(`${method}:${p.uri}`);
  return p.username === user && p.nonce === nonce && p.response === H(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
}

function createFakeCamera({ user = 'admin', password = 'geheim', events = [], tls = null } = {}) {
  const state = { calls: [], pulls: 0, subscribed: 0, renewed: 0, queue: events.slice() };
  const nonce = crypto.randomBytes(8).toString('hex');
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const port = server.address().port;
      if (req.method === 'GET' && req.url.startsWith('/cgi-bin/snap')) {
        if (!checkDigest(req.headers.authorization, user, password, 'GET', 'cam', nonce)) {
          res.writeHead(401, { 'WWW-Authenticate': `Digest realm="cam", nonce="${nonce}", qop="auth", algorithm=MD5` });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(JPEG);
      }
      const op = (/<s:Body><(?:\w+:)?(\w+)/.exec(body) || [])[1];
      state.calls.push(op);
      const send = (x, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/soap+xml' }); res.end(x); };
      if (op === 'GetSystemDateAndTime') {
        const d = new Date();
        return send(soapOk(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`));
      }
      if (!checkToken(body, user, password)) return send(FAULT, 400);
      const foreign = `${tls ? 'https' : 'http'}://203.0.113.9:${port}`;
      switch (op) {
        case 'GetDeviceInformation':
          return send(soapOk('<tds:GetDeviceInformationResponse><tds:Manufacturer>Reolink</tds:Manufacturer><tds:Model>E1 Zoom</tds:Model><tds:FirmwareVersion>v3.1.0</tds:FirmwareVersion><tds:SerialNumber>123</tds:SerialNumber></tds:GetDeviceInformationResponse>'));
        case 'GetCapabilities':
          return send(soapOk(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Events><tt:XAddr>${foreign}/onvif/events</tt:XAddr></tt:Events><tt:Media><tt:XAddr>${foreign}/onvif/media</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`));
        case 'GetProfiles':
          return send(soapOk('<trt:GetProfilesResponse>'
            + '<trt:Profiles token="Main"><tt:Name>Main</tt:Name><tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>'
            + '<trt:Profiles token="Sub"><tt:Name>Sub</tt:Name><tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>'
            + '</trt:GetProfilesResponse>'));
        case 'GetStreamUri': {
          const sub = /Sub</.test(body);
          return send(soapOk(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://203.0.113.9:554/h264Preview_01_${sub ? 'sub' : 'main'}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`));
        }
        case 'GetSnapshotUri':
          return send(soapOk(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>${foreign}/cgi-bin/snap?cmd=Snap&amp;channel=0</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`));
        case 'GetEventProperties':
          return send(soapOk('<tev:GetEventPropertiesResponse><wstop:TopicSet xmlns:wstop="w"><tns1:RuleEngine><MyRuleDetector><PeopleDetect/><VehicleDetect/><DogCatDetect/></MyRuleDetector><CellMotionDetector><Motion/></CellMotionDetector></tns1:RuleEngine></wstop:TopicSet></tev:GetEventPropertiesResponse>'));
        case 'CreatePullPointSubscription':
          state.subscribed++;
          return send(soapOk(`<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>${foreign}/onvif/sub1</wsa5:Address></tev:SubscriptionReference></tev:CreatePullPointSubscriptionResponse>`));
        case 'PullMessages': {
          state.pulls++;
          const ev = state.queue.shift();
          const msgs = ev ? `<wsnt:NotificationMessage><wsnt:Topic Dialect="d">${ev.topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="${new Date().toISOString()}"><tt:Source><tt:SimpleItem Name="Rule" Value="MyRule"/></tt:Source><tt:Data>${Object.entries(ev.items).map(([k, v]) => `<tt:SimpleItem Name="${k}" Value="${v}"/>`).join('')}</tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>` : '';
          const answer = () => send(soapOk(`<tev:PullMessagesResponse><tev:CurrentTime>${new Date().toISOString()}</tev:CurrentTime>${msgs}</tev:PullMessagesResponse>`));
          return ev ? answer() : setTimeout(answer, 200);
        }
        case 'Renew': state.renewed++; return send(soapOk('<wsnt:RenewResponse/>'));
        case 'Unsubscribe': return send(soapOk('<wsnt:UnsubscribeResponse/>'));
        default: return send(FAULT, 400);
      }
    });
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  return {
    state,
    JPEG,
    push: (e) => state.queue.push(e),
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  };
}

module.exports = { createFakeCamera, JPEG };
