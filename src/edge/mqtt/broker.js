'use strict';

// Dateien des lokalen Mosquitto-Brokers (Dienst `mqtt`, eclipse-mosquitto),
// geschrieben vom Edge-Host in das gemeinsame Volume /gc-mqtt:
//   mosquitto.conf   Listener nur an LAN-Adressen (+ 127.0.0.1 für den Edge-Host),
//                    allow_anonymous false, password_file, acl_file
//   passwd           Konten aus dem state (Hash im mosquitto_passwd-Format) + internes Konto
//   acl              je Konto die Themen aus dem state; internes Konto nur pluginTopics
//   reload           Zähler – ändert er sich, schickt der Wächter im mqtt-Container SIGHUP
//   enabled          vorhanden = Broker soll laufen
// Der Wächter im mqtt-Container startet Mosquitto neu, wenn sich mosquitto.conf
// ändert (Listener lassen sich per SIGHUP nicht ändern), sonst SIGHUP.
//
// Neue Compose-Datei (Edge-Container ohne Netz): diese Dateien schreibt der
// Gateway-Container nach /gc-mqtt-conf (tmpfs, gid 61001) – der Edge-Container
// hat darauf keinen Zugriff, kann also weder Bridges noch Plugins in die
// Broker-Konfiguration schreiben. Der Wächter kopiert sie nach /gc-mqtt
// (`brokerDir`, eigenes Volume des Brokers); dorthin zeigen auch die Pfade in
// mosquitto.conf. Ohne `brokerDir` gilt der alte Weg (eine Ablage für beides).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const INTERNAL_USER = 'gc-edge';
const PORT = 1883;
const TLS_PORT = 8883;
const ITERATIONS = 1000; // wie mosquitto_passwd -H sha512-pbkdf2 (2.1)

/** Hash im mosquitto_passwd-Format: $7$<iterationen>$<salz b64>$<pbkdf2-sha512 b64>. */
function hashPassword(password, { iterations = ITERATIONS, salt = crypto.randomBytes(64) } = {}) {
  const h = crypto.pbkdf2Sync(String(password), salt, iterations, 64, 'sha512');
  return `$7$${iterations}$${salt.toString('base64')}$${h.toString('base64')}`;
}

function verifyPassword(password, hash) {
  const m = /^\$7\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(hash);
  if (!m) return false;
  const want = Buffer.from(m[3], 'base64');
  const got = crypto.pbkdf2Sync(String(password), Buffer.from(m[2], 'base64'), Number(m[1]), want.length, 'sha512');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function buildConf({ dir, listenAddrs, tls }) {
  const lines = [
    '# Automatisch erzeugt vom GateControl-Edge-Host (docs/edge.md) – Änderungen gehen verloren.',
    'allow_anonymous false',
    `password_file ${dir}/passwd`,
    `acl_file ${dir}/acl`,
    'persistence true',
    `persistence_location ${dir}/data/`,
    'autosave_interval 300',
    'log_dest stdout',
    'log_dest topic',
    'log_type error',
    'log_type warning',
    'log_type notice',
    'connection_messages true',
    'max_packet_size 4194304', // bridge/devices von zigbee2mqtt (Funk) – Edge-Teile senden weiter höchstens 256 KB
    'max_queued_messages 1000',
    '',
    `listener ${PORT} 127.0.0.1`,
  ];
  for (const ip of listenAddrs) {
    if (!net.isIPv4(ip)) continue;
    lines.push(`listener ${PORT} ${ip}`);
  }
  if (tls && tls.certfile && tls.keyfile) {
    for (const ip of listenAddrs) {
      if (!net.isIPv4(ip)) continue;
      lines.push(`listener ${TLS_PORT} ${ip}`, `certfile ${tls.certfile}`, `keyfile ${tls.keyfile}`);
    }
  }
  return lines.join('\n') + '\n';
}

function buildPasswd(accounts, internalHash) {
  return [`${INTERNAL_USER}:${internalHash}`, ...accounts.map((a) => `${a.user}:${a.hash}`)].join('\n') + '\n';
}

function buildAcl(accounts, internalTopics) {
  const out = ['# Automatisch erzeugt vom GateControl-Edge-Host – Änderungen gehen verloren.', '',
    `user ${INTERNAL_USER}`, 'topic read $SYS/broker/clients/connected', 'topic read $SYS/broker/log/N'];
  for (const t of internalTopics) out.push(`topic readwrite ${t}`);
  for (const a of accounts) {
    out.push('', `user ${a.user}`);
    for (const r of a.acl) out.push(`topic ${r.access} ${r.topic}`);
  }
  return out.join('\n') + '\n';
}

function writeIfChanged(file, body, mode = 0o600) {
  try { if (fs.readFileSync(file, 'utf8') === body) return false; } catch { /* neu */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, file);
  return true;
}

class BrokerFiles {
  /** @param {string} dir Ablage, in die geschrieben wird; @param {{brokerDir?:string}} [o] Pfad aus Sicht von Mosquitto */
  constructor(dir, { brokerDir = dir } = {}) {
    this.dir = dir;
    this.brokerDir = brokerDir;
    // eigene Ablage: 0600 (Besitzer = Broker); Gateway-Ablage: 0640 (Gruppe 61001 über setgid, der Wächter liest)
    this.fileMode = brokerDir === dir ? 0o600 : 0o640;
    this.reloadSeq = 0;
  }

  available() {
    try { fs.accessSync(this.dir, fs.constants.W_OK); return true; } catch { return false; }
  }

  tlsFiles() {
    const certfile = path.join(this.dir, 'tls', 'server.crt');
    const keyfile = path.join(this.dir, 'tls', 'server.key');
    return fs.existsSync(certfile) && fs.existsSync(keyfile) ? { certfile, keyfile } : null;
  }

  /** Alles schreiben; liefert { confChanged, authChanged }. */
  write({ accounts, internalHash, internalTopics, listenAddrs, tls }) {
    // data/ legt im neuen Weg der Wächter im eigenen Volume an
    if (this.brokerDir === this.dir) fs.mkdirSync(path.join(this.dir, 'data'), { recursive: true, mode: 0o700 });
    const tlsFiles = tls ? this.tlsFiles() : null;
    const confChanged = writeIfChanged(path.join(this.dir, 'mosquitto.conf'), buildConf({ dir: this.brokerDir, listenAddrs, tls: tlsFiles }), this.fileMode);
    const a = writeIfChanged(path.join(this.dir, 'passwd'), buildPasswd(accounts, internalHash), this.fileMode);
    const b = writeIfChanged(path.join(this.dir, 'acl'), buildAcl(accounts, internalTopics), this.fileMode);
    if (a || b) writeIfChanged(path.join(this.dir, 'reload'), `${Date.now()}-${++this.reloadSeq}\n`, 0o644);
    writeIfChanged(path.join(this.dir, 'enabled'), '1\n', 0o644);
    return { confChanged, authChanged: a || b, tls: tls ? (tlsFiles ? 'on' : 'missing_cert') : 'off' };
  }

  disable() {
    try { fs.rmSync(path.join(this.dir, 'enabled'), { force: true }); } catch { /* weg */ }
  }
}

module.exports = { BrokerFiles, hashPassword, verifyPassword, buildConf, buildPasswd, buildAcl, INTERNAL_USER, PORT, TLS_PORT };
