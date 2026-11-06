# Lokale KI (Phase 3c, Schritt 3)

Ein KI-Modell im Heimnetz statt in der Cloud: Dokumente und Mails verlassen das
Haus nicht, es fallen keine Kosten an. Zwei Wege, beide über ein Gateway:

| Quelle | Was läuft wo |
|---|---|
| **Auf einem Gateway** (`source: service`) | Dienst `ki` (Ollama, gepinnt) neben dem Gateway; GateControl lädt das Modell (`/api/pull`), startet und beendet den Dienst. |
| **Vorhandener KI-Server im Heimnetz** (`source: lan`) | Ollama oder LM Studio auf einem PC im LAN. Das Gateway leitet weiter – **nur** an die eine eingestellte Adresse (private IPv4 + Port). |

Der Server (GateControl) kennt nur Gateway-Ids; Modelle, Fortschritt und
Antworten laufen über die Management-API des Gateways (Tunnel, `X-Gateway-Token`).
Plugins merken davon nichts: sie fragen wie bisher über `gc.ai`, der Server
entscheidet nach dem Modus, ob die lokale KI oder die Cloud antwortet.

## 1. Config-Pull `features.ai`

```json
{ "enabled": true, "source": "service", "lan": null }
{ "enabled": true, "source": "lan", "lan": { "url": "http://192.168.1.20:11434", "api": "ollama" } }
```

* `enabled` – aus: der Dienst `ki` wird beendet (Steuerdatei weg), der Proxy antwortet `503 feature_disabled`.
* `source` – `service` (Standard) oder `lan`.
* `lan.url` – nur `http://` oder `https://`, Host **nur als private IPv4-Adresse**
  (10/8, 172.16/12, 192.168/16), Port 1…65535 (ohne Port: 80/443), kein Pfad
  außer `/` bzw. `/v1`, keine Zugangsdaten. Alles andere → `lan: null` (aus).
* `lan.api` – `ollama` (`/api/*`) oder `openai` (OpenAI-kompatibel, `/v1/*`, z. B. LM Studio).
* Fehlt `features.ai` (älterer Server) → aus.

Capability `ai`. Server-Setting „welches Gateway, welches Modell, welcher
Modus“ bleibt am Server (`ai.local_peer`, `ai_providers` Zeile `local`,
`ai.local_use`).

## 2. Der Dienst `ki`

* Image `ollama/ollama:<Version>@sha256:<Digest>` (Multi-Arch amd64/arm64,
  ≈ 3 GB). Modelle im benannten Volume `ki-models` (`/root/.ollama`).
* `network_mode: host`, Ollama hört **nur** auf `127.0.0.1:11435`
  (nicht 11434 – ein vorhandenes Ollama auf demselben Gerät stört nicht; aus dem
  LAN nicht erreichbar). `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`,
  `OLLAMA_KEEP_ALIVE=10m`.
* Kleiner Wächter statt `ollama serve` (wie beim deCONZ-Dienst): liegt
  `/gc-ai/run` im tmpfs-Volume `ai-ctl`, startet er `ollama serve`, sonst beendet
  er es. Zustand in `/gc-ai/ki.state` (`running|idle|exit <Unix-Sekunden>`, alle 2 s).
* Vorrang des Gateways: `cpu_shares: 256` (Gateway 1024) und
  `oom_score_adj: 800` – wird der Speicher knapp, trifft es das Modell, nie
  Gateway/Tunnel. Inferenz läuft in einem eigenen Prozess; das Gateway streamt nur.
* `docker-compose.example.yml`: im Profil `ki` (ohne Schalter lädt niemand das
  Image). Die Compose-Datei aus GateControl enthält den Dienst ohne Profil,
  sobald die lokale KI für das Gateway eingeschaltet ist (wie deCONZ).
* Raspberry-Pi-Image: `ki` ohne Profil. `gatecontrol-start` nimmt den Dienst mit,
  wenn `gateway-state/ai.json` `"want":true` sagt; wird die KI eingeschaltet,
  während der Container fehlt, legt das Gateway `gateway-state/ai-start` an →
  `gatecontrol-ai.path` → `docker compose up -d --no-deps ki`. Aus in GateControl →
  beim nächsten Start entfernt (Modelle bleiben im Volume).

`service` in Telemetrie und Status: `managed` (Wächter lebt), `absent` (Volume
da, Container fehlt/steht), `missing` (kein `/gc-ai` – alte Compose-Datei).

## 3. Management-API (Server → Gateway)

| Route | Antwort |
|---|---|
| `POST /api/ai/status {}` | 200 `{ ai }` – frisch: Dienst, Version, Modelle (≤ 48), geladenes Modell, Download, Rechner (RAM, Kerne, GPU), bei `lan` Erreichbarkeit + Modelle; 503 `feature_disabled` |
| `POST /api/ai/pull { model }` | 202; 400 `invalid_model`; 409 `pull_running` \| `not_running` \| `lan_source`; 503 |
| `POST /api/ai/pull/cancel {}` | 202; 409 `no_pull` |
| `POST /api/ai/delete { model }` | 200 `{ deleted: true }`; 400; 404 `not_found`; 409 `not_running` |
| `POST /api/ai/chat { … }` | 200 NDJSON-Strom (unten); vorher 400 `invalid_request`, 409 `not_running` \| `model_missing`, 429 `busy`, 503 |

`model`: Ollama-Name `^[a-z0-9][a-z0-9._-]{0,63}(/[a-z0-9][a-z0-9._-]{0,63})?(:[A-Za-z0-9._-]{1,64})?$`.

### Chat

Anfrage (Body ≤ 2 MB, nur diese Route; sonst bleibt es bei 16 KB):

```json
{ "model": "llama3.2:3b", "system": "…", "messages": [{ "role": "user", "content": "…" }],
  "schema": { … } | null, "maxTokens": 1200, "temperature": 0.2, "numCtx": 8192, "timeoutMs": 300000 }
```

* `messages` 1…16, `role` `user|assistant`, Inhalt zusammen ≤ 1 000 000 Zeichen.
* `schema` → Ollama `format` (JSON-Schema) bzw. `response_format: json_schema`.
* `maxTokens` 1…8192, `numCtx` 2048…32768 (nur Ollama), `timeoutMs` 5 s…15 min.
* Höchstens **eine** Antwort zugleich, zwei weitere warten; mehr → 429 `busy`.

Antwort `application/x-ndjson`, eine JSON-Zeile je Ereignis:

```
{"wait":1}                                   alle 10 s, solange noch kein Text kam (Modell lädt / liest)
{"d":"Teiltext"}                             gesammelt, höchstens alle 250 ms
{"done":true,"model":"…","inputTokens":812,"outputTokens":95,"finish":"stop","ms":41230}
{"error":"timeout|unreachable|model_missing|too_large|bad_response|http_<n>","message":"…"}
```

Antworttext ≤ 256 KB, sonst `too_large`. Bricht der Server ab, bricht das
Gateway die Anfrage an Ollama ab.

### Weiterleitung an einen KI-Server im LAN

* Verbindung **nur** zu `lan.url` aus dem Config-Pull (Host und Port fest), eigene
  Pfade (`/api/chat`, `/api/tags`, `/api/version` bzw. `/v1/chat/completions`,
  `/v1/models`), keine Weiterleitungen (3xx = Fehler), keine Cookies, keine
  Zugangsdaten. Antworten ≤ 8 MB, Liste ≤ 1 MB.
* Kein Download und kein Löschen von Modellen auf fremden Servern.

## 4. Telemetrie `features.ai` (klein, Heartbeat ≤ 16 KB)

```json
{ "enabled": true, "source": "service", "service": "managed", "state": "running",
  "version": "0.40.8", "models": [{ "name": "llama3.2:3b", "size": 2019393189 }],
  "loaded": [{ "name": "llama3.2:3b", "size": 2700000000, "vram": 0, "until": "…" }],
  "pull": { "model": "llama3.2:3b", "state": "pulling", "completed": 1300000000, "total": 2019393189 },
  "host": { "memTotal": 16641478656, "cores": 4, "arch": "x64", "gpu": [] },
  "lan": null, "error": null }
```

`state`: `off` | `service_missing` | `starting` | `running` | `unreachable` (LAN-Server) | `error`.
`models` ≤ 12, `loaded` ≤ 2; `gpu` aus sysfs (`/sys/bus/pci/devices/*/class` 0x03…:
Hersteller `nvidia|amd|intel|other`) – nur ein Hinweis: der Dienst `ki` nutzt die
Grafikkarte in dieser Fassung nicht.

## 5. Server (GateControl)

* Anbieter `local` („Lokale KI“) neben den vier Cloud-Anbietern: Kosten 0 (keine
  Reservierung, keine Budgetbuchung, trotzdem im Protokoll), nur Text (Bilder →
  Cloud), Modellkatalog mit Download-/Speichergröße und Empfehlung je Gateway.
* Modus `ai.local_use`:
  * `all` – „Für alles“: lokal zuerst; Cloud nur, wenn die lokale KI nicht
    antwortet (offline, besetzt, Zeit um, Modell fehlt) oder ein Bild verstehen muss.
  * `private` – „Nur für private Inhalte“: Text-Anfragen von Drive und Mail
    (`gatecontrol-drive`, `gatecontrol-mail`) lokal, **ohne** Cloud-Ausweich;
    alles andere wie bisher.
  * `fallback` – „Nur als Ausweich“: wie bisher, lokal erst, wenn das Monatsbudget
    der Cloud aufgebraucht ist (oder kein Cloud-Anbieter eingerichtet ist).
* Zeit: lokale Anfragen bekommen mindestens 5 Minuten (CPU ist langsam), der
  Server liest den Strom; ohne Zeile 120 s → Zeit um.
