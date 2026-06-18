'use strict';
const { execFile } = require('node:child_process');
const logger = require('../logger');

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function assertIpv4(ip) {
  const m = IPV4.exec(ip || '');
  if (!m || m.slice(1).some(o => Number(o) > 255)) throw new Error(`bad IPv4: ${ip}`);
}
function assertPort(p) { if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port: ${p}`); }

/** argv for `iptables` (prepend -A/-D). NAT PREROUTING REDIRECT <vip>:<dport> -> <toPort>. */
function buildRedirectRuleArgs(vip, dport, toPort) {
  assertIpv4(vip); assertPort(dport); assertPort(toPort);
  return ['-t','nat','PREROUTING','-d',vip,'-p','tcp','--dport',String(dport),'-j','REDIRECT','--to-ports',String(toPort)];
}
/** argv for `ip addr [add|del] <args>`. */
function buildAliasArgs(vip, prefix, iface) {
  assertIpv4(vip);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`bad prefix: ${prefix}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(iface || '')) throw new Error(`bad iface: ${iface}`);
  return [`${vip}/${prefix}`, 'dev', iface];
}

function _run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, _out, stderr) => {
      // Idempotency: treat "exists"/"No such file"/"does not exist" as success.
      if (err && !/exist|not found|No such|does not exist/i.test(stderr || err.message)) {
        logger.warn({ bin, args, err: (stderr || err.message).trim() }, 'near apply failed');
        return resolve({ ok: false, err: (stderr || err.message).trim() });
      }
      resolve({ ok: true });
    });
  });
}
const addRedirect    = (vip, dport, toPort) => _run('iptables', ['-A', ...buildRedirectRuleArgs(vip, dport, toPort)]);
const removeRedirect = (vip, dport, toPort) => _run('iptables', ['-D', ...buildRedirectRuleArgs(vip, dport, toPort)]);
const addAlias       = (vip, prefix, iface) => _run('ip', ['addr','add', ...buildAliasArgs(vip, prefix, iface)]);
const delAlias       = (vip, prefix, iface) => _run('ip', ['addr','del', ...buildAliasArgs(vip, prefix, iface)]);

module.exports = { buildRedirectRuleArgs, buildAliasArgs, addRedirect, removeRedirect, addAlias, delAlias };
