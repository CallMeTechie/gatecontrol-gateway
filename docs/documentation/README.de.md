# Home Gateway — User- & Admin-Dokumentation

🇩🇪 **Deutsch** — 🇬🇧 [English version](README.md)

Vollständige User- und Admin-Dokumentation für den GateControl Home Gateway. Lies diese fünf Dokumente der Reihe nach wenn du neu bist; pick dir das aus was du brauchst wenn du eine spezifische Frage hast.

Für **Deployment** (wie installiere ich den Gateway-Container auf meiner Plattform) siehe das Schwester-Verzeichnis [`../deployment/`](../deployment/). Für den **Top-Level-Repo-Überblick** (Features, Architektur, Quick Start) siehe [`../../README.md`](../../README.md).

## Die fünf Dokumente

| # | Dokument | Inhalt | Wann lesen |
|---|---|---|---|
| **01** | [User Journey](01-user-journey.de.md) | Fünf sequenzielle End-to-End-Walkthroughs: NAS-Freigabe, RDP, WoL, L4-Dienst, mehrere Geräte | Als Erstes. Wie ein Tutorial durcharbeiten. |
| **02** | [Decision Guide](02-decision-guide.de.md) | Wann Home Gateway, wann klassischer WireGuard-Peer, mit Szenario-Playbook | Bevor du dich für die Topologie entscheidest |
| **03** | [Features Reference](03-features-reference.de.md) | Volle Fähigkeits-Referenz: HTTP/L4-Proxy, WoL, RDP, Auto-Sync, Heartbeat, Management-API, Logging | Wenn du spezifische Details brauchst |
| **04** | [Troubleshooting](04-troubleshooting.de.md) | Diagnose-Katalog für die häufigen Fehlerbilder + wie man einen brauchbaren Bug-Report schreibt | Wenn was kaputt geht |
| **05** | [Security Model](05-security-model.de.md) | Threat-Model, Vertrauensgrenzen, Container-Hardening, Angriffsoberfläche, Audit-Trail | Bevor du interne Dienste exponierst |

## Leseweg nach Rolle

**Homelabber ("Ich will mein NAS von überall erreichen"):**
1 → 4 wenn was bricht.

**Admin der für ein kleines Team / NGO evaluiert:**
2 → 1 → 5 → 3 nach Bedarf.

**Security-Reviewer:**
5 → 3 → 4.

**Developer der über die Management-API integriert:**
3 → [Server-Repo-Docs](https://github.com/CallMeTechie/gatecontrol).

## Sprache

Jedes Dokument ist als Englisch-Version vorhanden (ohne `.de`-Suffix). Die Sprach-Indexseite ist die [englische README](README.md). Inhalte werden pro-Commit synchron gehalten — wenn DE sich ändert, wird EN im gleichen PR nachgezogen.
