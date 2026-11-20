'use strict';

// Management-API (nur Tunnel, Gateway-Token): GateControl legt für „Statusseite
// im VPN öffnen“ ein Einmal-Ticket ab (docs/setup-page.md „Aus dem VPN per
// HTTPS“). Übergeben wird nur der SHA-256 des Tickets; das Ticket selbst geht
// vom Server direkt an den Browser des Admins.

const express = require('express');
const logger = require('../../logger');

function createStatusPageRouter({ getVpnStatus }) {
  const router = express.Router();
  router.post('/status-page/ticket', (req, res) => {
    const vpn = getVpnStatus();
    if (!vpn) return res.status(404).json({ ok: false, error: 'not_available' });
    const body = req.body || {};
    const r = vpn.issueTicket({ sha256: typeof body.ticket_sha256 === 'string' ? body.ticket_sha256.toLowerCase() : null, ttlS: body.ttl_s });
    if (!r.ok) return res.status(r.error === 'bad_request' ? 400 : 409).json(r);
    logger.info({ expires_in_s: r.expiresInS }, 'Status page over the VPN: login ticket from GateControl');
    return res.json({ ok: true, host: r.host, port: r.port, expires_in_s: r.expiresInS });
  });
  return router;
}

module.exports = { createStatusPageRouter };
