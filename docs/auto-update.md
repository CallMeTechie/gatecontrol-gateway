# GateControl Gateway — Auto-Update

The gateway supports server-triggered self-update via a file flag watched on the host. When the GateControl server schedules an update (via `POST /api/self-update`), it writes `/state/pending-update`. A host-side watcher detects the flag and runs `deploy/update.sh`.

---

## The `/state` volume

The gateway container mounts `./gateway-state` on the host as `/state` (read-write). This directory is the shared channel between the container (writes the flag, reads `last-pull`) and the host updater (reads the flag, writes `last-pull`).

Create the directory before first start:

```bash
mkdir -p ./gateway-state
```

The `docker-compose.example.yml` includes the bind mount:

```yaml
volumes:
  - ./config:/config:ro
  - ./gateway-state:/state          # rw: self-update flag + last-pull marker (#2b)
```

---

## Linux — systemd path unit (recommended)

The `.path` unit uses `inotify` to react to the flag within milliseconds.

### Install

```bash
# Copy units (adjust ExecStart path inside .service if gateway is not at /opt/gatecontrol-gateway)
cp deploy/systemd/gatecontrol-gateway-update.service /etc/systemd/system/
cp deploy/systemd/gatecontrol-gateway-update.path    /etc/systemd/system/

# If the gateway lives elsewhere, edit ExecStart before enabling:
# nano /etc/systemd/system/gatecontrol-gateway-update.service

systemctl daemon-reload
systemctl enable --now gatecontrol-gateway-update.path
```

### Verify

```bash
systemctl status gatecontrol-gateway-update.path
journalctl -u gatecontrol-gateway-update.service -f
```

The `.path` unit re-arms automatically after the flag is removed (consumed on lock), so every new flag triggers a fresh run.

---

## Synology DSM — Task Scheduler (polling)

DSM does not support systemd. Use the built-in Task Scheduler with a short polling interval instead. Note: polling introduces up to 1–2 minutes of latency between the server writing the flag and the update starting.

### Setup

1. Open **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**.
2. Set:
   - **Task name**: `GateControl Gateway Auto-Update`
   - **User**: `root`
   - **Schedule**: Repeat every **1 minute** (or 2 minutes to reduce overhead)
   - **Run command**:
     ```bash
     /opt/gatecontrol-gateway/deploy/update.sh
     ```
     Adjust the path if the repo is cloned elsewhere.
3. Save and enable the task.

The script is safe to run on every invocation — if no `/state/pending-update` flag exists it exits immediately (after acquiring the lock, which takes < 1 ms). The flock lock also prevents overlap if a run takes longer than one polling interval.

---

## Lockfile and consume-on-lock behavior

`update.sh` uses an exclusive non-blocking `flock` on `.update.lock` (next to `docker-compose.yml`). Key behaviors:

- **Only one update at a time**: a second invocation while an update is running exits immediately without writing to `last-pull`.
- **Consume-on-lock**: the flag (`/state/pending-update`) is read and then deleted inside the locked section. A new flag written by the server while an update is in progress will persist and trigger the next run — no update request is silently dropped.
- **request_id passthrough**: the `request_id` from the flag JSON is carried through to `last-pull`, letting the server match the telemetry to the original update request regardless of clock skew.

---

## Side-effect files next to `docker-compose.yml`

The updater creates these files in the same directory as `docker-compose.yml`:

| File | Purpose |
|------|---------|
| `.update.lock` | `flock` lock file — always present after first run; harmless |
| `docker-compose.rollback.yml` | Created on rollback; pins the previous image digest; deleted on the next successful update |
| (in `./gateway-state/`) `update.log` | Append-only log of every update run |

Add them to `.gitignore` to avoid accidental commits:

```
.update.lock
docker-compose.rollback.yml
```

---

## Rollback behavior

If the new container fails its health check within `GC_GW_HEALTH_CEILING` seconds (default 300 s), the updater:

1. Writes a `docker-compose.rollback.yml` override file that pins `image:` to the previous container's repo digest (e.g. `ghcr.io/callmetechie/gatecontrol-gateway@sha256:...`).
2. Runs `docker compose -f docker-compose.yml -f docker-compose.rollback.yml up -d --force-recreate` to restore the old image.
3. Records `"ok":false` in `/state/last-pull`, which the server telemetry endpoint reports upstream.

On the next **successful** update the rollback override file is deleted, and the pinned digest is no longer in effect.

If no previous digest is available (e.g. the image was built locally and never pushed), rollback is skipped and only the failure is logged.

---

## Dry-run verification

Use this to confirm the pipeline is wired up end-to-end without waiting for the server to schedule an update:

```bash
# 1. Write a fake flag
echo '{"request_id":"dryrun"}' > ./gateway-state/pending-update

# 2. Wait for the watcher to fire (systemd: < 1 s; DSM poller: up to 1–2 min)

# 3. Verify the flag was consumed and last-pull was written
ls ./gateway-state/pending-update   # should be gone (No such file or directory)
cat ./gateway-state/last-pull       # should contain "request_id":"dryrun"
```

Example expected output of `last-pull`:

```json
{"request_id":"dryrun","pulled_at":1748217600000,"image_digest":"ghcr.io/callmetechie/gatecontrol-gateway@sha256:...","ok":true}
```

If `ok` is `false` and a rollback file appeared, inspect `./gateway-state/update.log` for the health-check output.
