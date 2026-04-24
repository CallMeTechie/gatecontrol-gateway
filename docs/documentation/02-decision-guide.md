# Decision Guide: Home Gateway vs. Classic Peer

GateControl supports two peer topologies. This document explains the tradeoffs so you pick the right one per device and per use case. Many real deployments mix both: a Home Gateway for household devices plus a classic Peer for a work laptop.

If you are brand new, read **[01 — User Journey](01-user-journey.md)** first for an example-driven walkthrough.

---

## One-Minute Summary

- **Home Gateway:** one always-on Docker container in your LAN acts as a bridge for *every* device on that LAN. One WireGuard tunnel, unlimited destinations. Required when the target cannot or should not run WireGuard itself (printer, NAS, IoT, sleeping desktop that needs WoL).

- **Classic Peer:** a device with WireGuard installed connects directly. One tunnel per device. Right for laptops, mobile devices, per-user VPN, servers with static configuration.

---

## Side-by-side Comparison

| Criterion | Home Gateway | Classic Peer |
|---|---|---|
| **Install WireGuard on each target?** | No | Yes |
| **One tunnel covers many LAN devices** | Yes | No — one tunnel per device |
| **Reach printers / IoT / TVs** (no WG client available) | Yes | No |
| **Wake-on-LAN from outside** | Yes (built in) | No |
| **Per-user authentication** (different humans = different accounts) | Limited (route-auth) | Yes (dedicated peer per user) |
| **Bring-your-own-device** (friend visits, uses your printer) | Yes — just route | No — needs their own peer |
| **Always-on requirement** | LAN host must stay up | Each device decides |
| **Setup complexity** | Medium — container + routes | Low — one config + toggle |
| **Network mode** | Host network typically required | Bridge is fine |
| **Traffic encryption LAN-side** | Plain (Gateway → LAN is within your home) | Encrypted (WG on the device itself) |
| **Scales with devices** | Flat — add routes, not peers | Linear — peer per device |
| **Recovers from target reboot** | Transparent | Transparent, but WG must auto-start |
| **Device uses server's IP for outbound** | No — target keeps LAN routing | Yes — full-tunnel peer uses server as exit |
| **Kill-switch semantics** | Gateway is the client | Device is the client |

Read the rows in order if you're new. The critical question is usually **"can I install WireGuard on the target?"** — if the answer is no (printer, IoT, NAS without root, sleeping PC, old router's admin UI), you want a Home Gateway.

---

## Scenario Playbook

### "I want to access my NAS web UI from anywhere"

→ **Home Gateway.** Synology/UnRAID/TrueNAS typically don't have first-class WireGuard support, and you'd rather not run a VPN client on the NAS itself.

### "My laptop should tunnel all its traffic through my GateControl server when I'm on public WiFi"

→ **Classic Peer** with full-tunnel (`AllowedIPs = 0.0.0.0/0`). Install WireGuard on the laptop once, toggle the tunnel when you need it.

### "I have a sleeping gaming PC at home, I want to wake it and RDP into it from my phone"

→ **Home Gateway** (the only one with WoL support). The sleeping PC cannot answer anything; the Gateway sends the magic packet, waits, then tunnels RDP through.

### "I want to give a colleague access to one specific service at my office, nothing else"

→ **Home Gateway** plus **route-auth** on that single route (email OTP or TOTP). The colleague doesn't need a WireGuard client, no device setup on their side — just a browser.

### "I want a 24/7 home server that can reach my office network"

→ **Classic Peer** on that server. Full-tunnel or split-tunnel depending on what you want routable.

### "I have a mix — home server + printers + NAS + kid's iPad"

→ **Home Gateway** for the printers, NAS, and IoT (no WG on those) **plus** classic Peers for the home server and the iPad (mobile users). Both topologies coexist on the same GateControl server.

### "I run a homelab with 20+ services, each on different LAN devices"

→ **Home Gateway.** One container, 20 routes in the admin UI. Adding a service is a new route, not a new peer.

### "I manage 10 customer sites and want one VPN to see them all"

→ **One Home Gateway per site.** Each site-Gateway has its own peer in GateControl; you see all sites as separate peers in the dashboard. Better isolation (each site's LAN traffic stays on that site's Gateway), clearer monitoring, independent reboot/update cycles.

---

## When NOT to use a Home Gateway

- **The target already runs WireGuard perfectly.** A Linux server with `wg-quick` set up needs no Gateway — you'd just add a proxy hop. Classic Peer is simpler and faster.
- **You have a single user on a single device.** One laptop → classic Peer. A Gateway is overkill.
- **The target is mobile.** A Gateway assumes a stable LAN host. A phone or laptop that moves networks is a classic Peer.
- **Every device must have its own identity** (per-user audit, different ACLs per device). Home Gateway gives one identity (the Gateway) and then relies on route-auth for per-user separation; if you need device-level attribution, use classic Peers.

---

## Can I run both?

Yes. Most real deployments do. Mixed topology is first-class in GateControl — peers and gateway-peers live in the same list, same dashboard, same monitoring.

Typical split:

- **Gateway** for everything stationary in your home/office (NAS, printers, IoT, workstations that users log into via RDP)
- **Peers** for everything mobile (laptops, phones, admin devices)

---

## Next

- **[01 — User Journey](01-user-journey.md)** — end-to-end walkthroughs of the top five scenarios
- **[03 — Features Reference](03-features-reference.md)** — full list of what the Gateway can do
- **[04 — Troubleshooting](04-troubleshooting.md)** — network-mode gotchas, WoL doesn't wake, etc.
