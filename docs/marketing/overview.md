# GateControl Home Gateway — Product Overview

Marketing-ready copy for the GateControl Home Gateway. Ready to drop into a website, a README intro, a product-hunt launch, or a sales conversation. Multiple lengths included so you can pick the one that fits the medium.

---

## Taglines (pick one)

- **"Your home network. Reachable from anywhere. Owned by you."**
- **"One container at home. All your devices, remote."**
- **"Remote access to your home — without the compromises."**

---

## 50-word elevator pitch

Run a single Docker container on a Raspberry Pi, Synology, or any Linux box at home. Every device on your LAN — NAS, home PC, smart-home hub, printer, gaming desktop — becomes reachable from anywhere through your own domain, with automatic HTTPS and Wake-on-LAN built in. No router configuration. No third-party cloud.

---

## 200-word hero copy (landing page)

### Finally: remote access to your home that you actually own.

The GateControl Home Gateway is a small Docker container that runs on any always-on device in your home — a Raspberry Pi, a Mini-PC, your Synology NAS, a VM on Proxmox. Once it's running, every service on your home network is reachable from anywhere on the internet: your NAS, Home Assistant, Plex, Jellyfin, the admin interface of your router, your sleeping gaming desktop. All through clean HTTPS URLs on your own domain (`nas.example.com`, `hass.example.com`, `rdp.example.com`), with Let's Encrypt certificates issued automatically.

There are **no port forwards on your home router**, because traffic arrives through a WireGuard tunnel you control. There are **no VPN clients installed on any of your devices**, because the Gateway handles everything on their behalf. And there's **no third-party cloud between you and your data**, because the public endpoint is a server you own — typically a €5/month VPS.

If your gaming PC is asleep, the Gateway wakes it on demand. If a service goes down, you see it in the dashboard. If someone probes for vulnerabilities, your home network stays invisible behind a tunnel it initiated itself.

**Self-hosted. Open source. Yours.**

---

## Five reasons people actually like it

### 1. No port forwarding, no dynamic DNS, no router surgery
Your home router never sees an inbound connection. The Gateway opens one outbound WireGuard tunnel; everything rides that. The attack surface your ISP-supplied modem exposes to the internet stays at zero.

### 2. One container covers every device on your LAN
Don't install WireGuard on your NAS. Don't install anything on your printer. Don't bother with an agent on the smart TV. The Gateway is the agent for all of them. Add a route in the web UI; the target device needs to know nothing about it.

### 3. Real HTTPS on real domains
Your NAS shows up as `https://nas.yourdomain.com` with a green padlock and a Let's Encrypt certificate trusted by every browser and every mobile app. Not `https://192.168.1.50:5001` with a self-signed warning. Not `https://yourname.somecloud.net`. Your brand, your domain.

### 4. Wake-on-LAN, actually working
The gaming desktop is off 23 hours a day. You want to RDP into it exactly when you need it. The Gateway sees the incoming connection attempt, sends the magic packet, waits for the OS, then tunnels your session through. First connect takes 20–40 seconds; after that it's instant until you disconnect.

### 5. Your data, your server, your audit log
The public endpoint is your VPS. The tunnel keys live on your hardware. The activity log is in a SQLite file on that VPS — readable, exportable, yours to retain or delete. No telemetry to a third party. No "we've updated our privacy policy" email six months from now.

---

## Who this is for

### The homelabber
You have a Synology NAS, a Home Assistant box, a Plex server, and maybe a Pi-hole. You've tried dyndns + port forwards; it was flaky. You've tried Tailscale; you don't love that your traffic flows through their control plane. You want a domain that works from your phone, your parents' WiFi, the cafe — and you want the pipe to be one you control end-to-end.

### The small-office admin
Four people in a shared office. Two of them work from home some days. You need to give them access to the shared NAS, the license server, maybe an RDP session to the shared Windows machine. You don't want to install a VPN client on every personal device. You don't want someone's laptop dropping a kill-switch-less tunnel in a cafe. You want per-route authentication so Alice can see the NAS but not the license server.

### The prosumer family
You host photos at home. The parents-in-law want to view the kids' pictures. A friend is visiting and wants to stream that movie you've been raving about. None of them should install a VPN client; none of them needs to know what an IP address is. You share a URL, they log in with their email, they see only what you've granted them.

### The one-person consultant
You run a home office with a mix of work devices and personal gear. The work desktop is powerful; the road laptop is thin. You want to RDP into the desktop from the laptop when on-site at a client. You don't want to maintain a VPN infrastructure. You want something you can set up in an afternoon and forget about.

---

## How it compares

| | **GateControl Home Gateway** | Tailscale / ZeroTier | Cloudflare Tunnel | Classic Port-Forward + DynDNS | Per-device WireGuard |
|---|---|---|---|---|---|
| **Own the infrastructure end-to-end** | Yes — your VPS | Partial — their control plane | No — their edge | Yes | Yes, per device |
| **Works for devices that can't run a VPN client** (NAS, printer, IoT, TV) | Yes — one container covers all | No — agent per device | Yes | Yes, but open port per service | No |
| **Automatic Let's Encrypt on your domain** | Yes, zero-config | No — needs extra tooling | Yes | No — manual | No |
| **Wake-on-LAN from outside** | Built in | No | No | No | No |
| **Keys and logs stay on your server** | Yes | No — control plane is theirs | No — data flows through them | Yes | Yes |
| **Setup complexity for N devices** | One container, N routes | One agent per device | One tunnel per service | N router rules + N cert workflows | N WireGuard configs |
| **Per-route user authentication** | Yes (email OTP, TOTP) | No | Yes (with extra config) | No | No |
| **Open source, self-hostable** | Yes | Partial (control plane is SaaS) | No | Yes (but no real UI) | Yes (but no UI at all) |
| **Required: always-on LAN host** | Yes | No | No | No | No |
| **Required: domain you own** | Yes | No | Yes | Yes | No |

---

## Under the hood

**Modern cryptography.** All tunnel traffic uses the standard WireGuard primitives — Curve25519 for key exchange, ChaCha20-Poly1305 for authenticated encryption, BLAKE2s for hashing. Post-quantum resistance via preshared keys is enabled by default. Route-auth passwords are hashed with Argon2id.

**Security-hardened container.** The Gateway runs as a non-root user inside a read-only filesystem with all Linux capabilities dropped except the two required for WireGuard and low-port binding (`NET_ADMIN`, `NET_BIND_SERVICE`). Docker's default seccomp profile is active. Writable paths are tmpfs only; nothing persists inside the container across restarts.

**Let's Encrypt automatic.** Every HTTP route gets an ACME-issued certificate without manual configuration. Caddy handles renewal, rollover, and the occasional rate limit quietly in the background.

**No telemetry.** The Gateway only talks to your own server. There is no phone-home, no anonymous statistics beacon, no license check. You can blackhole everything except your VPS at the firewall and it still works.

**Open source.** The source code is on GitHub and can be audited, forked, and patched. Container images are published to GitHub Container Registry with reproducible builds and CVE scanning on every release.

---

## Frequently asked questions

### Is this replacing my VPN?

It depends on what you use a VPN for. If you use a VPN to access your home resources remotely, yes — the Home Gateway replaces that use case with cleaner semantics (per-service URLs, per-route auth, automatic TLS). If you use a VPN for privacy on public WiFi — routing your laptop's traffic through an exit node — that's a different use case, and GateControl's classic WireGuard peer mode handles it.

### Do I need a public static IP on my home?

No. The Gateway makes an outbound connection to your VPS; the VPS is what needs the static IP (or DNS record). Your home internet can have a dynamic IP and NAT, just like millions of households do.

### How much does this cost to run?

The software is free. You need a Linux VPS to host the GateControl server — any €3–5/month provider works (Hetzner Cloud, Scaleway, OVH, DigitalOcean). The Gateway container runs on hardware you already have. A Raspberry Pi 4 is plenty; a Mini-PC or the Synology you already own is fine.

### What happens if my VPS is down?

Your services remain unreachable from outside until the VPS is back. They remain reachable from inside your home LAN as they always were. Since the VPS is a standard Linux box, you can replace or rebuild it in minutes using automatic backups; VPS providers give you SLAs in the "99.9%" range, so in practice this is rare.

### How secure is it if the target LAN device has a vulnerability?

GateControl does not patch your internal applications. If your Synology has a vulnerability, exposing it through the Gateway reaches the same code as exposing it through a port forward. The Gateway lets you **layer additional authentication** (route-auth with email OTP or TOTP) on top of any service, which many home users find worthwhile for legacy admin interfaces.

### Can I run multiple Gateways?

Yes, often recommended. One per site (home, office, vacation place) or one per security domain (IoT VLAN vs. work VLAN). Each Gateway is a separate peer on the GateControl server; you see them all side-by-side in the dashboard.

### What happens if the Gateway container crashes?

Docker's health-check restarts it within seconds. The server-side health state machine tolerates brief outages; persistent failures surface as an "offline" badge in the dashboard and (since v1.54) trigger a TCP probe to detect recovery without waiting for the next heartbeat.

### Is this secure enough for my accounting software / client files / actual business data?

The transport is as secure as WireGuard plus TLS 1.3 can be. The access controls (Argon2id passwords, per-route auth, audit log) are production-grade. The **overall** security of your deployment depends on what's at both endpoints: are your VPS and your Gateway host patched, is your target application itself secure, are your users using strong passwords. GateControl provides the pipe; application security remains the application's responsibility.

---

## Ready-to-paste copy blocks

### Tweet / Mastodon (280 chars)

> Self-hosted remote access to your home network. One container on a Pi, every device on your LAN reachable via `https://yourdomain.com` with Let's Encrypt certificates. No port forwards, no VPN client per device, no third-party cloud. GateControl Home Gateway.

### README intro (for downstream projects integrating it)

> **GateControl Home Gateway** is an always-on container that bridges a single WireGuard tunnel to every device on your LAN. HTTP and TCP proxies, Wake-on-LAN, auto-sync with a GateControl server — so any home service is reachable through clean HTTPS URLs on your own domain, without router configuration or per-device VPN clients.

### Product Hunt / Hacker News summary (3–4 sentences)

> Open-source companion to [GateControl](https://github.com/CallMeTechie/gatecontrol) for homelabbers and prosumers who want remote access to their home network without Tailscale-style third-party control planes. Runs as a single Docker container on a Pi or NAS. Exposes LAN devices under your own domain with automatic Let's Encrypt, Wake-on-LAN, and per-route user authentication. Nothing proprietary, nothing phone-home; you own the VPS, the tunnel, the domain, and the keys.

### Email / forum post signature

> Built with GateControl Home Gateway — self-hosted remote access to your home network. github.com/CallMeTechie/gatecontrol-gateway

---

## Next steps for the reader

After reading marketing copy, interested users typically want:

- **"What does this actually look like?"** → [User Journey walkthroughs](../documentation/01-user-journey.md)
- **"Is this right for my setup?"** → [Decision Guide](../documentation/02-decision-guide.md)
- **"Is this as secure as you say?"** → [Security Model](../documentation/05-security-model.md)
- **"How do I install it?"** → [Deployment Docs](../deployment/)
