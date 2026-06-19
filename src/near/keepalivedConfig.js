'use strict';

/** Render a keepalived.conf for one or more egress VIP instances (VRRP unicast). */
function buildKeepalivedConf({ iface, healthCheckCmd, instances }) {
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
}
`;
  }).join('\n');
  return head + blocks;
}

module.exports = { buildKeepalivedConf };
