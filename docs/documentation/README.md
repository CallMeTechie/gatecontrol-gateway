# Home Gateway — User & Admin Documentation

🇬🇧 **English** — 🇩🇪 [Deutsche Fassung](README.de.md)

Complete user and admin documentation for the GateControl Home Gateway. Read these five documents in order if you are new; pick the one you need if you have a specific question.

For **deployment** (how to install the Gateway container on your platform) see the sibling directory [`../deployment/`](../deployment/). For the **top-level repo overview** (features, architecture, Quick Start) see [`../../README.md`](../../README.md).

## The five documents

| # | Document | What it covers | When to read it |
|---|---|---|---|
| **01** | [User Journey](01-user-journey.md) | Five sequential end-to-end walkthroughs: NAS exposure, RDP, WoL, L4 service, multiple devices | First. Run it like a tutorial. |
| **02** | [Decision Guide](02-decision-guide.md) | When to use a Home Gateway vs. a classic WireGuard peer, with a scenario playbook | Before you decide the topology |
| **03** | [Features Reference](03-features-reference.md) | Full capability reference: HTTP/L4 proxy, WoL, RDP, auto-sync, heartbeat, management API, logging | As you need specific details |
| **04** | [Troubleshooting](04-troubleshooting.md) | Diagnostic catalogue for the common failure modes + how to file a useful bug report | When something breaks |
| **05** | [Security Model](05-security-model.md) | Threat model, trust boundaries, container hardening, attack surface, audit trail | Before exposing internal services |

## Reading path by persona

**Homelabber ("I want my NAS reachable from everywhere"):**
1 → 4 when something breaks.

**Admin evaluating for a small team / non-profit:**
2 → 1 → 5 → 3 as needed.

**Security reviewer:**
5 → 3 → 4.

**Developer integrating via the management API:**
3 → [server repo docs](https://github.com/CallMeTechie/gatecontrol).

## Language

Every document is mirrored in German with the `.de.md` suffix. The language index is the [German README](README.de.md). Content is kept in sync per-commit — when EN changes, DE is updated in the same PR.
