'use strict';

/** Render a keepalived.conf for one or more egress VIP instances (VRRP unicast). */
function buildKeepalivedConf({ iface, routerIdBase = 50, healthCheckCmd, notifyDir, instances }) {
  if (!iface) throw new Error('iface required');
  const head =
`global_defs {
    enable_script_security
    script_user root
}

vrrp_script chk_tunnel {
    script "${healthCheckCmd}"
    interval 5
    timeout 3
    rise 2
    fall 2
    weight -60
}
`;
  const blocks = (instances || []).map((i) => {
    const peers = (i.unicastPeers || []).map(p => `        ${p}`).join('\n');
    return `
vrrp_instance ${i.name} {
    state BACKUP
    interface ${iface}
    virtual_router_id ${i.vrid}
    priority ${i.priority}
    advert_int 1
    nopreempt
    unicast_src_ip ${i.unicastSrc}
    unicast_peer {
${peers}
    }
    virtual_ipaddress {
        ${i.vip}/${i.vipPrefix || 24}
    }
    track_script {
        chk_tunnel
    }
    notify_master "${notifyDir}/${i.name}_master.sh"
    notify_backup "${notifyDir}/${i.name}_backup.sh"
    notify_fault  "${notifyDir}/${i.name}_backup.sh"
}
`;
  }).join('\n');
  return head + blocks;
}

/** Render the master notify script: bring VIP-bound REDIRECT up (idempotent). */
function renderMasterScript({ vip, dport, toPort }) {
  return `#!/bin/sh
iptables -t nat -C PREROUTING -d ${vip} -p tcp --dport ${dport} -j REDIRECT --to-ports ${toPort} 2>/dev/null \
  || iptables -t nat -A PREROUTING -d ${vip} -p tcp --dport ${dport} -j REDIRECT --to-ports ${toPort}
`;
}
/** Render the backup/fault notify script: tear the REDIRECT down (idempotent). */
function renderBackupScript({ vip, dport, toPort }) {
  return `#!/bin/sh
iptables -t nat -D PREROUTING -d ${vip} -p tcp --dport ${dport} -j REDIRECT --to-ports ${toPort} 2>/dev/null || true
`;
}

module.exports = { buildKeepalivedConf, renderMasterScript, renderBackupScript };
