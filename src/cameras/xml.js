'use strict';

// Kleiner, toleranter XML-Leser für ONVIF/SOAP und WS-Discovery (Kamera-
// Eingabe, also fremd): Namensraum-Präfixe fallen weg, nur die fünf
// Standard-Entitäten und Zeichenreferenzen, keine DTD (<!DOCTYPE → Fehler,
// kein Entity-Nachladen), Tiefe ≤ 64, Knoten ≤ 20 000.

const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

class XmlError extends Error {
  constructor(message) { super(message); this.code = 'bad_xml'; }
}

const local = (name) => { const i = name.indexOf(':'); return i >= 0 ? name.slice(i + 1) : name; };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
  });
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** XML-Text → Wurzelknoten { name, attrs, children, text } */
function parse(xml) {
  const s = String(xml);
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += decode(s.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decode(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlError('unterminated comment');
      i = e + 3; continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      if (e < 0) throw new XmlError('unterminated cdata');
      stack[stack.length - 1].text += s.slice(lt + 9, e);
      i = e + 3; continue;
    }
    if (s.startsWith('<!', lt)) throw new XmlError('dtd not allowed');
    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2);
      if (e < 0) throw new XmlError('unterminated declaration');
      i = e + 2; continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) throw new XmlError('unterminated tag');
    const raw = s.slice(lt + 1, gt);
    i = gt + 1;
    if (raw[0] === '/') {
      const name = local(raw.slice(1).trim());
      // tolerant: bis zum passenden offenen Knoten schließen
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!m) throw new XmlError('bad tag');
    const node = { name: local(m[1]), attrs: {}, children: [], text: '' };
    ATTR_RE.lastIndex = 0;
    let a;
    const rest = body.slice(m[1].length);
    while ((a = ATTR_RE.exec(rest)) !== null) {
      const k = a[1];
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      node.attrs[local(k)] = decode(a[2] !== undefined ? a[2] : a[3]);
    }
    if (++nodes > MAX_NODES) throw new XmlError('too many nodes');
    stack[stack.length - 1].children.push(node);
    if (!selfClose) {
      if (stack.length > MAX_DEPTH) throw new XmlError('too deep');
      stack.push(node);
    }
  }
  return root;
}

/** Erster Knoten mit diesem (lokalen) Namen, Tiefensuche. */
function find(node, name) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.name === name) return c;
    const r = find(c, name);
    if (r) return r;
  }
  return null;
}

/** Alle Knoten mit diesem Namen (Tiefensuche, höchstens `max`). */
function findAll(node, name, max = 256, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (out.length >= max) break;
    if (c.name === name) out.push(c);
    findAll(c, name, max, out);
  }
  return out;
}

/** Direktes Kind mit diesem Namen. */
function child(node, name) {
  return node ? node.children.find((c) => c.name === name) || null : null;
}

/** Text eines Knotens (getrimmt, mit dem der Kinder). */
function text(node) {
  if (!node) return '';
  let t = node.text;
  for (const c of node.children) t += text(c);
  return t.trim();
}

/** Text des ersten Knotens mit diesem Namen ('' ohne). */
function textOf(node, name) {
  return text(find(node, name));
}

module.exports = { parse, find, findAll, child, text, textOf, XmlError };
