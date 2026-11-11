# Lokale KI (Phase 3c, Schritt 3)

Ein KI-Modell im Heimnetz statt in der Cloud: Dokumente und Mails verlassen das
Haus nicht, es fallen keine Kosten an. Zwei Wege, beide über ein Gateway:

| Quelle | Was läuft wo |
|---|---|
| **Auf einem Gateway** (`source: service`) | Dienst `ki` (Ollama, gepinnt) neben dem Gateway; GateControl lädt das Modell (`/api/pull`), startet und beendet den Dienst. |
| **Vorhandener KI-Server im Heimnetz** (`source: lan`) | Ollama, LM Studio, vLLM, llama.cpp-Server oder LocalAI auf einem PC im LAN. Das Gateway leitet weiter – **nur** an die eine eingestellte Adresse (private IPv4/IPv6 oder ein Name, der auf eine private Adresse zeigt, + Port), auf Wunsch mit API-Schlüssel. |

Der Server (GateControl) kennt nur Gateway-Ids; Modelle, Fortschritt und
Antworten laufen über die Management-API des Gateways (Tunnel, `X-Gateway-Token`).
Plugins merken davon nichts: sie fragen wie bisher über `gc.ai`, der Server
entscheidet nach dem Modus, ob die lokale KI oder die Cloud antwortet.

## 1. Config-Pull `features.ai`

```json
{ "enabled": true, "source": "service", "lan": null }
{ "enabled": true, "source": "lan", "lan": { "url": "http://192.168.1.20:11434", "api": "ollama" } }
{ "enabled": true, "source": "lan", "lan": { "url": "http://ki-pc.local:8000", "api": "openai", "keyRev": "<16 Hex-Zeichen>" } }
{ "enabled": true, "source": "lan", "lan": { "url": "https://192.168.1.20:11434", "api": "ollama", "pin": "<64 Hex-Zeichen>" } }
```

* `enabled` – aus: der Dienst `ki` wird beendet (Steuerdatei weg), der Proxy antwortet `503 feature_disabled`.
* `source` – `service` (Standard) oder `lan`.
* `lan.url` – nur `http://` oder `https://`, Port 1…65535 (ohne Port: 80/443), kein
  Pfad außer `/` bzw. `/v1`, keine Zugangsdaten. Der Host (ab 1.31.0):
  * eine **private IPv4-Adresse** (10/8, 172.16/12, 192.168/16),
  * eine **private IPv6-Adresse** (fc00::/7, ULA) in Klammern: `http://[fd00::20]:11434`,
  * ein **Name** im Heimnetz: `nas`, `ki-pc.local`, `pc.fritz.box`, `llm.home.arpa`
    (Buchstaben, Ziffern, Bindestrich; nie `localhost`).

  Nie Loopback, Link-Local (169.254/16, fe80::/10, Cloud-Metadaten), CGNAT oder
  öffentliche Adressen. Alles andere → `lan: null` (aus). Ein **Name** wird erst beim
  Verbinden auf dem Gateway aufgelöst (`src/ai/resolve.js`): `.local` per mDNS (das
  Image hat kein nss-mdns; Antwort ≤ 3 s, 5 Min. gemerkt), sonst der DNS des Hosts
  (60 s gemerkt). Verbunden wird **nur an die privaten Adressen** der Antwort
  (IPv4 zuerst; öffentliche fallen weg) – über einen eigenen `lookup` von
  `http.request`, also genau an die geprüfte Adresse (kein DNS-Rebinding). Löst ein
  Name nur öffentlich auf → Fehler `not_private`, keine Verbindung. Bei `https` gilt
  der Name für SNI und die Zertifikatsprüfung.
* `lan.api` – `ollama` (`/api/*`) oder `openai` (OpenAI-kompatibel, `/v1/*`: LM Studio,
  vLLM, llama.cpp-Server, LocalAI).
* `lan.keyRev` (ab 1.31.0) – es gibt einen **API-Schlüssel** für diesen Server; der
  Wert ändert sich mit jedem neuen Schlüssel. Der Schlüssel selbst steht **nie** im
  Config-Pull: das Gateway holt ihn mit seinem API-Token über
  `GET /api/v1/gateway/ai/credentials` → `{ "rev": "…", "key": "…" }` (der Server gibt
  ihn nur dem Gateway, das die lokale KI weiterleitet; sonst `{ rev: null, key: null }`).
  Er bleibt im Speicher und verschlüsselt in `/state/ai-cred.bin` (0600, AES-256-GCM,
  Schlüssel per HKDF aus dem Gateway-Token) – ein Neustart braucht den Server nicht.
  Er geht als `Authorization: Bearer <Schlüssel>` an den KI-Server (Ollama hinter einem
  Proxy, vLLM `--api-key`, LocalAI, LM Studio, llama.cpp `--api-key`), nie ins Log und
  nie in die Telemetrie. Fehlt `keyRev`, vergisst das Gateway den Schlüssel (auch die
  Datei). Antwortet der Server mit 401/403 → Fehler `unauthorized`.
* `lan.pin` (nur `https`, Capability-Eintrag `lanPin` in `supports`) – der
  **SHA-256-Fingerabdruck des Server-Zertifikats** (64 Hex-Zeichen; Doppelpunkte,
  Großbuchstaben und `sha256:` werden angenommen), den der Admin in GateControl
  bestätigt hat. Ein KI-Server mit `https` hat im Heimnetz fast immer ein selbst
  signiertes Zertifikat; ohne Pin lehnt das Gateway es ab (`tls_untrusted`) – die
  Prüfung wird **nie** abgeschaltet. Mit Pin ersetzt der Fingerabdruck die
  Ketten- und Namensprüfung (derselbe Mechanismus wie `backend_tls_fingerprint` der
  HTTPS-Routen, `src/proxy/tlsPin.js`): jede Verbindung – Zustand, Modell-Liste,
  Chat – gibt es nur mit **genau diesem** Zertifikat, vorher geht kein Byte der
  Anfrage hinaus (auch kein API-Schlüssel); keine wiederverwendeten Verbindungen,
  keine TLS-Sitzungen. Zeigt der Server ein anderes Zertifikat →
  `tls_pin_mismatch`, Zustand `unreachable`, bis der Admin das neue bestätigt. Ein
  unlesbarer Pin passt auf kein Zertifikat (lieber keine Verbindung). Ohne
  `lan.pin` (älterer Server, öffentlich gültiges Zertifikat) bleibt die normale
  Prüfung.
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

### 2.1 Grafikkarte (ab 1.31.0)

In GateControl je Gateway „Grafikkarte nutzen“: *Nein* · *NVIDIA* · *AMD (ROCm)* ·
*Intel (experimentell)*. Die Wahl landet in der heruntergeladenen Compose-Datei
(Dienst `ki` ohne Profil, mit den Geräten) – kein weiterer Schritt außer dem
Compose-Download, den es für den Dienst `ki` ohnehin gibt. Von Hand dasselbe mit
den Zusatzdateien neben `docker-compose.example.yml`:

| Datei | Was sie ändert | Braucht auf dem Rechner |
|---|---|---|
| `docker-compose.ki-nvidia.yml` | `deploy.resources.reservations.devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]` | NVIDIA-Treiber ≥ 550 und das **NVIDIA Container Toolkit** (`nvidia-ctk runtime configure --runtime=docker`). Ohne Toolkit startet der Container nicht. |
| `docker-compose.ki-amd.yml` | Image `ollama/ollama:0.40.8-rocm@sha256:…` (nur amd64), `devices: [/dev/kfd, /dev/dri]` | amdgpu-Treiber mit `/dev/kfd` (ROCm 7). Fehlt `/dev/kfd`, startet der Container nicht. |
| `docker-compose.ki-intel.yml` | `devices: [/dev/dri]` (Ollama nutzt Vulkan, im Image enthalten) | i915- oder xe-Treiber (`/dev/dri/renderD*`). Experimentell. |

Jede setzt `GC_KI_GPU` (`none` im Dienst `ki` selbst). Nutzung:
`COMPOSE_FILE=docker-compose.yml:docker-compose.ki-nvidia.yml` und `COMPOSE_PROFILES=ki`
in `.env`. Nie zwei zugleich. Der Raspberry-Pi-Image-Dienst bleibt ohne GPU.

**Was das Gateway meldet** (`src/ai/gpu.js`, nur lesend, ohne Rechte):

* **Rechner** (sysfs/procfs, im Gateway-Container lesbar): je Grafikkarte (PCI-Klasse
  0x03…, höchstens 4) `vendor` (`nvidia|amd|intel|other`), `driver` (der geladene
  Kernel-Treiber: `nvidia`, `nouveau`, `amdgpu`, `radeon`, `i915`, `xe` …), `vramMb`
  (AMD: `mem_info_vram_total`), `integrated` (Intel auf Bus 0, AMD-APU < 2 GB), `name`
  (NVIDIA: `/proc/driver/nvidia/gpus/<pci>/information`); dazu `nvidiaDriver`
  (`/sys/module/nvidia/version`), `kfd` (`/sys/class/kfd/kfd`), `render`
  (`/sys/class/drm/renderD*`).
* **Dienst `ki`**: der Wächter schreibt alle 60 s `/gc-ai/ki.gpu`:
  ```
  mode nvidia                       GC_KI_GPU der Compose-Datei
  at 1730000000
  dev nvidia0 | nvidiactl | kfd | renderD128   was der Container sieht
  nv NVIDIA GeForce RTX 3060, 12288, 550.54.14 nvidia-smi (Name, MiB, Treiber), mit Toolkit
  ```
  Daraus `gpu: { mode, devices: [nvidia|kfd|dri], access, cards: [{ name, vramMb, driver }], used }`
  (`access`: sieht der Container die Geräte seiner Art; `used`: das geladene Modell liegt im
  Grafikspeicher – `/api/ps` `size_vram > 0`). Älter als 5 Min. oder fehlt → `null`
  (alte Compose-Datei, Dienst fehlt).

Der Server macht daraus die Hinweise (Treiber fehlt/zu alt, Toolkit fehlt, ROCm fehlt,
Compose-Datei hat eine andere GPU-Art) und die Modellgrößen nach Grafikspeicher –
Hinweise, nie ein Verbot.

## 3. Management-API (Server → Gateway)

| Route | Antwort |
|---|---|
| `POST /api/ai/status {}` | 200 `{ ai }` – frisch: Dienst, Version, Modelle (≤ 48), geladenes Modell, Download, Rechner (RAM, Kerne, GPU), bei `lan` Erreichbarkeit + Modelle; 503 `feature_disabled` |
| `POST /api/ai/pull { model }` | 202; 400 `invalid_model`; 409 `pull_running` \| `not_running` \| `lan_source`; 503 |
| `POST /api/ai/pull/cancel {}` | 202; 409 `no_pull` |
| `POST /api/ai/delete { model }` | 200 `{ deleted: true }`; 400; 404 `not_found`; 409 `not_running` |
| `POST /api/ai/chat { … }` | 200 NDJSON-Strom (unten); vorher 400 `invalid_request`, 409 `not_running` \| `model_missing`, 429 `busy`, 503 |
| `POST /api/ai/probe { url, api?, key?, pin? }` (ab 1.31.0; `pin`, `pinned`, `certificate` mit `supports: lanPin`) | 200 `{ probe: { reachable, url, api, version, models, auth, pinned, certificate, error } }` – „Verbindung testen“ in der Einrichtung: einen KI-Server im LAN fragen, **ohne** etwas zu speichern (geht auch, solange die lokale KI aus ist). Gleiche Prüfung wie `lan.url` (nur private Ziele, Namen nur zu privaten Adressen); `key` nur für diesen Test, nie gespeichert. `https`: `pin` heftet das Zertifikat für diesen Test an (`pinned`). Besteht das Zertifikat die Prüfung nicht (`error.code: tls_untrusted`) oder ist es nicht das angeheftete (`tls_pin_mismatch`), trägt `certificate` das gezeigte Zertifikat `{ sha256, subject, issuer, validTo, selfSigned }` – gelesen nur mit einem TLS-Handshake (keine Anfrage, kein Schlüssel), damit der Admin den Fingerabdruck vergleichen und bestätigen kann. 400 `invalid_url` \| `invalid`; 429 `busy` (ein Test zugleich) |

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

* Verbindung **nur** zu `lan.url` aus dem Config-Pull (Host und Port fest; ein Name
  nur an seine privaten Adressen), eigene Pfade (`/api/chat`, `/api/tags`,
  `/api/version` bzw. `/v1/chat/completions`, `/v1/models`), keine Weiterleitungen
  (3xx = Fehler), keine Cookies; als Zugangsdaten nur der API-Schlüssel (Bearer), wenn
  es einen gibt. Antworten ≤ 8 MB, Liste ≤ 1 MB.
* Fehlercodes: `unreachable`, `not_private` (Name zeigt nicht ins Heimnetz),
  `unauthorized` (401/403: Schlüssel fehlt oder falsch), `timeout`, `redirect`,
  `bad_response`, `http_<n>`; bei `https` dazu `tls_untrusted` (das Zertifikat
  besteht die Prüfung nicht – selbst signiert, unbekannter Aussteller, abgelaufen,
  falscher Name) und `tls_pin_mismatch` (nicht das angeheftete Zertifikat).
* `https`: ohne `lan.pin` die normale Zertifikatsprüfung, mit `lan.pin` nur genau
  dieses Zertifikat (§1). `rejectUnauthorized: false` gibt es nur im Pin-Agenten,
  der den Socket erst nach bestandenem Fingerabdruck herausgibt.
* Kein Download und kein Löschen von Modellen auf fremden Servern.

## 4. Telemetrie `features.ai` (klein, Heartbeat ≤ 16 KB)

```json
{ "enabled": true, "source": "service", "service": "managed", "state": "running",
  "version": "0.40.8", "models": [{ "name": "llama3.2:3b", "size": 2019393189 }],
  "loaded": [{ "name": "llama3.2:3b", "size": 2700000000, "vram": 0, "until": "…" }],
  "pull": { "model": "llama3.2:3b", "state": "pulling", "completed": 1300000000, "total": 2019393189 },
  "host": { "memTotal": 16641478656, "cores": 4, "arch": "x64",
            "gpu": [{ "vendor": "nvidia", "driver": "nvidia", "vramMb": null, "integrated": false, "name": "NVIDIA GeForce RTX 3060" }],
            "nvidiaDriver": "550.54.14", "kfd": false, "render": true },
  "gpu": { "mode": "nvidia", "devices": ["nvidia"], "access": true,
           "cards": [{ "name": "NVIDIA GeForce RTX 3060", "vramMb": 12288, "driver": "550.54.14" }], "used": true },
  "lan": null, "supports": ["gpu", "lanKey", "lanHost", "probe", "lanPin"], "error": null }
```

`state`: `off` | `service_missing` | `starting` | `running` | `unreachable` (LAN-Server) | `error`.
`models` ≤ 12, `loaded` ≤ 2; `host.gpu` und `gpu` siehe §2.1 (bis 1.30.0 stand in
`host.gpu` nur der Hersteller, und der Dienst nutzte keine Grafikkarte). `lan` bei
`source: lan`: `{ url, api, reachable, auth, pinned }` (`auth`: ein Schlüssel ist da – nie der
Schlüssel; `pinned`: das Zertifikat ist angeheftet). `supports` (ab 1.31.0): was dieses Gateway über 1.26.0 hinaus kann – der
Server schaltet danach frei (GPU-Wahl, API-Schlüssel, Namen/IPv6, „Verbindung testen“,
`lanPin`: angeheftetes Zertifikat für `https`).

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
* API-Schlüssel des LAN-Servers: verschlüsselt in der Zeile `local` von `ai_providers`
  (wie die Cloud-Schlüssel); die Seiten sehen nur die letzten vier Zeichen. Der Server
  selbst verbindet sich nie mit dem LAN-Server – das tut nur das Gateway. Einen
  „Internet-Endpunkt“ für die lokale KI gibt es nicht (dafür sind die Cloud-Anbieter da).
* Modellgrößen: mit „Grafikkarte nutzen“ und bekanntem Grafikspeicher (nvidia-smi über
  den Dienst `ki`, AMD aus sysfs) zählt, ob das Modell ganz hineinpasst (schnell, wenig
  Arbeitsspeicher) oder nur teilweise; Katalog bis Qwen 2.5 14B/32B.
