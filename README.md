# Stackarr MVP

Stackarr is an Arr-focused control plane MVP for Docker Compose environments. It is intentionally narrow: install and manage the media automation stack from one controller rather than trying to be a generic homelab dashboard.

## Scope

This MVP is built around:

- Prowlarr
- Radarr
- Sonarr
- Lidarr
- Bazarr
- Trailarr
- Ombi
- Tautulli
- SABnzbd

The core workflow is:

1. Install Stackarr once.
2. Fill out one host-level wizard.
3. Generate per-app Compose folders.
4. Deploy apps from the dashboard.
5. Check health, open the app, and run per-service or bulk upgrades.

## Current Validated State

As of August 5, 2026, all eight catalog services run under Stackarr management
on the live QNAP. Six were imported from existing containers; Prowlarr and
Bazarr were installed from the catalog in one click. See
[docs/qnap-first-test.md](docs/qnap-first-test.md) for the per-service detail.

Validated on that host:

- Stackarr runs as its own controller container on QNAP through `deploy/compose.example.yml`
- host detection and validation succeed against the QNAP share layout using `docker` inside the controller container
- adoption scan finds the live stack without exposing secret values in the UI
- managed drafts preserve the live container shape, including host networking, a custom network with a static address, named volumes, and entrypoint/command overrides
- per-service versions are read from image labels, so `:latest` tags still show a real release
- a real upgrade, a rollback to the previous image digest, and an upgrade forward that cleared the pin
- one-click install of Prowlarr and Bazarr, both healthy and able to reach the rest of the stack

The dashboard can also run a read-only adoption scan:

1. Inspect current Docker containers.
2. Match supported Arr/Ombi/Tautulli services by name or image.
3. Show mounts, ports, restart policy, networks, and env key names only.
4. Flag obvious adoption issues such as missing `/config`, `/Media`, or `/plex_logs` mounts.

## What The MVP Already Does

- Host-level setup wizard
- Host detection with confidence hints and QNAP-aware suggestions
- Arr-focused service catalog
- Per-app Compose generation
- `.env` generation beside each stack, with a key-only `.env.example` that documents the expected keys without repeating this host's resolved paths
- Catalog-installed services join a shared `stackarr` network so they resolve each other by container name; imported services keep the network they were already on
- Per-service version read from image labels rather than the image tag
- Image rollback to the previously running digest, verified before it is kept, with automatic restore if it fails to come up
- Read-only Docker inventory scan for existing container adoption
- Per-container adoption preview
- Safe managed-draft generation for recognized existing containers
- Managed drafts preserve the live container image, ports, restart policy, mounts, entrypoint, command, and custom Docker networks
- Managed drafts also write `import-summary.json` and `IMPORT-REVIEW.md` beside the Compose files for cutover review
- Imported drafts are persisted in local Stackarr state so later save, generate, and install actions keep using the reviewed draft files instead of snapping back to catalog defaults
- Managed runtime detection now handles the single-object `docker compose ps --format json` output seen on QNAP one-service projects
- Per-service deploy
- Per-service update check
- Per-service upgrade
- Upgrade-all action
- Deep links into each app
- Interactive demo mode with simulated actions and stub app destinations
- Reachability checks against each app URL
- Compose runtime checks via `docker compose ps`
- Pre-upgrade backups of compose files and container inspect output
- Each backup also writes `rollback.json` recording the image id and repo digest the container was running before the operation, so a rollback can pin the previous image instead of re-pulling a mutable tag
- Per-service cutover and revert from the dashboard, run as background jobs with a live step checklist (see [Cutover](#cutover))
- App removal with explicit choices about configuration, image, and backups, and a preview of exactly what will be deleted (see [Removing An App](#removing-an-app))

## Removing An App

Removal is a job like cutover, with a preview first:

```text
GET  /api/services/:serviceId/removal-preview -> { targets, preserved, warnings }
POST /api/services/:serviceId/remove          -> 202 { job }
```

The preview reports real paths and measured sizes so the choice is informed
rather than a guess about what a checkbox does.

Always removed: the container and the generated stack folder.

Optional, each an explicit choice:

- **Configuration and database** — the app's `/config`, whether that is a bind
  path or a named volume. Keeping it lets you reinstall exactly where you left
  off.
- **The image** — disk space only; it is kept automatically if another service
  still uses it.
- **Stackarr backups** — including the config snapshots that make rollback
  possible.

**Media and downloads are never offered.** They are shared mounts used by every
app in the stack, not data any one service owns, so deleting them while
removing a single app would destroy the library and break everything else. The
dialog says so explicitly rather than staying silent about it.

Two more safeguards: a final config snapshot is taken before the configuration
is destroyed (unless the backups are being deleted too, which would make it
pointless), and removing a service other apps depend on — Prowlarr or SABnzbd —
warns which apps break.

## Rollback

Every install and upgrade writes `rollback.json` recording the image id and repo
digest the container was running beforehand. A `Roll Back` button appears on a
managed service once such a record exists and its image is still present on the
host.

```text
POST /api/services/:serviceId/rollback -> 202 { job }
```

Rollback pins the image digest directly into `compose.yml` and recreates the
container, then verifies it the same way a cutover does. If it fails to come
up, the newer image is restored automatically. The pin stays until an upgrade
clears it, so a rolled-back service will not silently jump forward on the next
deploy — and upgrading always clears the pin first, so it can still move
forward when you want it to.

### Backup retention

Every install, upgrade, and rollback writes a backup with a config snapshot, so
they accumulate — one afternoon of upgrade testing left nine snapshots for a
single service. `Settings -> Backups -> Backups Kept` controls how many are
retained per service; older ones are pruned automatically after each new
backup lands.

The default keeps **only the latest**. Keeping more lets you roll back further
than one step, at the cost of disk. `Keep all` disables pruning entirely.

A value of zero or below is read as "keep all" rather than "keep none", since
keeping no backups would silently remove the ability to roll back at all.

### Configuration snapshots

Reverting the image alone is not always enough. A major upgrade often migrates
the application's database forward, and the older version may then refuse to
read it. So every backup also captures the service's `/config` — database and
settings — into `config-snapshot.tar.gz` beside the image record.

Rollback can then optionally restore that snapshot:

```json
{ "confirmContainerName": "tautulli", "restoreConfig": true }
```

This is **opt-in and destructive**: it rewinds the application's data to the
moment before the upgrade, discarding anything recorded since. The dashboard
presents it as an unchecked box with that warning spelled out, and only when a
snapshot actually exists for the rollback point.

Snapshots work for both bind mounts and named volumes, since they run through a
helper container rather than the controller's own filesystem. Regenerable
directories (`logs`, `MediaCover`, `Backups`, `cache`) are excluded, which keeps
a typical capture to tens of megabytes.

The service is stopped before its configuration is replaced, because restoring
a database under a running app would leave it holding stale handles. If the
restore fails, the service is brought back up before the failure is reported.

## Cutover

A cutover moves one detected container from manual Docker management to a Stackarr-managed Compose stack. Because the managed draft reuses the live container's name, the original container has to release that name first — so the cutover stops it, renames it to `<name>-stackarr-rollback`, and only then starts the Compose service.

The original container is **renamed, never removed**. That is what makes revert cheap: it is a rename back, not a rebuild from the inspect backup. Stackarr never deletes it, on success or failure; removing it is your call once the replacement has been used.

In the dashboard: open `Adoption`, scan, preview a recognized container, and generate its managed draft. `Cut Over To Compose` then appears. The confirmation dialog requires typing the container name, and progress renders as a live step checklist. Once a service is cut over, a revert button appears on its row in `Stack` for as long as the rollback container exists.

Cutover runs as a background job because it is destructive and can outlive a request:

```text
POST /api/import/:containerId/cutover   -> 202 { job }
POST /api/services/:serviceId/revert-cutover -> 202 { job }
GET  /api/jobs/:jobId                   -> { job }
GET  /api/jobs                          -> { jobs }
```

Both POST bodies require `confirmContainerName` matching the container being replaced. A mismatch is rejected before anything is touched.

The job reports a fixed step plan (`preflight`, `backup`, `stop`, `rename`, `deploy`, `verify`, `revert`, `finalize`) from the moment it is created, so progress can be polled and rendered as a checklist.

Preflight refuses the cutover when:

- the host profile is not configured, or the service has no reviewed import draft
- the live container no longer matches the reviewed draft — a container recreated or reconfigured since the draft was written would otherwise be silently rolled back to the older shape
- a rollback container from an earlier attempt still exists

Verification is tiered, because "running" is not "working":

- a container healthcheck reporting `healthy` is decisive
- with no healthcheck, an acceptable HTTP response from the app URL verifies it
- a container that is running but proves nothing either way is reported as `unverified` rather than success

Jobs are persisted to `data/jobs.json` and survive a controller restart. A job that was still running when the process died is reported as interrupted rather than left looking live, with a step list showing how far it got. The job panel reattaches after a page reload, so refreshing mid-cutover does not orphan it, and a job that finished while the page was away is still shown.

To try this against a real Docker daemon before touching a live stack, see [docs/live-cutover-test.md](docs/live-cutover-test.md).

Outcomes:

| Outcome | Job status | What happens |
| --- | --- | --- |
| `verified` | succeeded | Service is recorded as Compose-managed. Rollback container kept. |
| `unverified` | succeeded | Same, but health was never confirmed. Rollback container kept so you can revert. |
| Container exited, or Compose failed to start | failed | Automatically reverted to the original container. |

## Stack Wiring

The Stack tab's **Check Wiring** button reports how the apps are connected to each other. It is read-only: it reads each app's API key from its own config file, works out the address each app must use to reach the others, compares that against what is configured, and then asks each app to run its **own** connection tests.

Using the app's tests rather than probing from the controller matters on a mixed stack. A controller-side probe only proves that *Stackarr* can reach something, from Stackarr's network position. What the configuration needs is whether *Radarr* can reach SABnzbd, from Radarr's.

Addresses are derived from `docker inspect`, never composed from `hostUrl` and a port. On a QNAP the difference is not academic: SABnzbd on a `qnet` network answers on its own LAN address, while the host address at the same port is the NAS administration interface — which returns `200` and would look exactly like success.

Each connection is reported in one of six states:

| State | Meaning |
| --- | --- |
| `correct` | Configured, and the app's own test passed |
| `absent` | Nothing configured |
| `drift` | Configured, but pointing somewhere other than the resolved address |
| `ambiguous` | Several comparable entries exist and none match, so nothing can be assumed |
| `blocked` | This host's networking cannot carry the connection at all |
| `pending` | The app has only just started and has not written its API key yet |

A seventh state sits alongside these: **needs you**. Stackarr configures everything that is not a secret, so what remains is credentials it cannot hold — an indexer key, a Usenet account, a Plex token. The check reports each one, what it breaks, and a link straight to the page that fixes it.

That distinction matters because the two fail independently. A stack whose every connection is correct and whose Prowlarr has no indexers is perfectly wired and cannot find a single release, so the verdict says so rather than reporting `ready`.

These are not read, only counted or checked for presence. Arr apps mask fields marked `privacy: apiKey`, so an indexer key already configured in Radarr comes back as `***` and could not be copied into Prowlarr even if that were wanted. Detection and a link are genuinely the most that can be done, and handing credentials to a controller that has no authentication yet would be a worse place for them than the app that needs them.

`pending` is deliberately distinct from `absent`. A freshly installed app writes `config.xml` a few seconds after first start, and reporting that as missing turns a normal startup into a false alarm.

**Configure** then acts on the `absent` rows only, as a job you can watch. Payloads are built by patching values into the schema each app publishes, so fields Stackarr does not name keep the app's own defaults — your categories and priorities survive. Each payload is tested against the app before it is saved, and a refusal is reported with the app's own words rather than overridden: Arr apps offer a `forceSave` escape hatch, and using it produces configuration that looks right and never works.

Prowlarr applications are registered with `syncLevel: addOnly`, so indexers you configured directly inside an Arr are not deleted by the first sync.

Identity is matched on implementation plus address, never on the entry's name — users rename these — and API keys are never persisted, never logged, and never returned by the API. The check reports only the key's source file and a truncated `sha256` fingerprint. Objects fetched from an app are re-projected field by field rather than passed through, so what reaches the response is always a decision rather than whatever the remote app happened to send.

## Host Paths And The Controller

The controller can only see what its own Compose file mounted. A directory that
plainly exists on the host is invisible to it otherwise, and every existence
check inside the container then reports it missing — technically true, and
thoroughly misleading.

Those five host paths therefore live in two places by necessity: in
`settings.json`, where the app reads them, and in `deploy/.env`, where Compose
reads them before the container it configures exists. A process inside that
container cannot tell Compose what to mount, so the file cannot be eliminated.

What it can do is stop drifting. Saving host settings rewrites `deploy/.env`
from them, preserving the values Stackarr does not own — port, log level, and
the data directory, which is where settings themselves live. Recreate the
controller for new paths to take effect; the app says so rather than leaving it
to be discovered.

When the two do disagree, the dashboard names the variable that fixes it instead
of reporting the path as missing.

## The Three Scenarios

Setup, deployment, wiring, and removal are checked against three situations that
differ in what already exists: building new, deleting and redeploying, and
adopting a stack that predates Stackarr. They catch different bugs, and a change
that improves one has more than once broken another. See
[docs/scenarios.md](docs/scenarios.md).

## What Is Still Deliberately Missing

- Authentication and multi-user access control
- Repairing app-to-app configuration that already exists (Stackarr adds missing connections, but a link that points somewhere unexpected is reported for you to change inside the app)
- Indexer, Usenet account, and Plex credentials — detected and linked to, never held
- Remote path mapping writes (disagreeing paths are detected and described, but not yet corrected)
- Reverse proxy and certificate automation
- One-click indexer/download-client/provider setup inside each app
- Generic marketplace support for unrelated self-hosted software

## Project Shape

```text
stackarr/
├── deploy/              # example controller deployment files
├── docs/                # product and architecture docs
├── public/              # static frontend
├── src/
│   ├── lib/             # store, templates, runtime, status logic
│   └── server.js        # Express API + static app host
├── data/                # local controller state, ignored by git
└── test/                # Node test runner coverage for core logic
```

## Run Locally

```bash
cd stackarr
npm install
npm run dev
```

Then open `http://localhost:4687`.

## Run As A Docker Controller

Stackarr can now run as its own container while still managing the host Docker daemon.

Requirements:

- mount the Docker socket into the Stackarr container
- mount the host paths Stackarr needs to inspect at the same absolute paths inside the container
- keep Stackarr's own `data/` directory on persistent storage

Quick start:

```bash
cd stackarr/deploy
cp .env.example .env
docker compose -f compose.example.yml up -d --build
```

Nothing needs editing first. Every path has a working default, so the controller
starts, and its setup wizard then detects the right ones for this machine — a
QNAP's `/share/Media`, a Synology's `/volume1/media`, a plain Linux box's
`/srv/media`. Saving those settings rewrites `.env`, and one more
`docker compose up -d` puts the mounts where they belong.

That ordering is deliberate. The paths are questions the wizard already asks, so
asking them again in a file you have to get right before anything will start is
work for no reason — and a wrong value there used to fail with
`invalid spec: ::ro: empty section between colons`.

Important:

- `HOST_STACK_ROOT`, `HOST_CONFIG_ROOT`, `HOST_MEDIA_ROOT`, and `HOST_DOWNLOADS_ROOT` in `.env` must match the real host paths
- the controller creates the shared `stackarr` Docker network on first start; nothing needs to exist beforehand
- those paths are mounted into the container at the exact same absolute paths so generated Compose files, backups, and adoption scans stay aligned with the host
- remove the Plex logs mount line from `compose.example.yml` if you do not use Tautulli or do not want Plex log health support yet
- controller logs are written to `${STACKARR_DATA_DIR}/stackarr.log` and also mirrored to `docker logs stackarr`
- set `STACKARR_LOG_LEVEL=debug` in `deploy/.env` when you want verbose Docker command and request logging during troubleshooting

### First Test On QNAP

For the QNAP setup validated on August 5, 2026, the example `deploy/.env.example` values already match the expected share layout:

```text
HOST_STACK_ROOT=/share/Container/docker
HOST_CONFIG_ROOT=/share/Container
HOST_MEDIA_ROOT=/share/Media
HOST_DOWNLOADS_ROOT=/share/Media/Downloads
HOST_PLEX_LOGS_ROOT=/share/Container/plex/Logs
```

After the container starts:

1. open `http://<nas-ip>:4687`
2. go to `Settings`
3. run `Detect Host`
4. confirm the detected paths and keep `Docker Binary` as `docker`
5. save without deploy first
6. scan existing containers from `Adoption`
7. review generated stack folders before recreating any managed service

If host validation fails, Stackarr now blocks setup and returns a specific Docker or path error instead of silently saving a broken profile.

For the current live status, the validated Trailarr cutover, and the recommended order for the remaining migrations, see [docs/qnap-first-test.md](docs/qnap-first-test.md).

## Logging

Stackarr now keeps two different operational records:

- `data/activity.json`: user-facing activity feed with summarized action history
- `data/jobs.json`: cutover and revert job records, including their step-by-step outcome
- `data/stackarr.log`: structured JSONL operation log for requests, Docker commands, setup/import actions, upgrades, and failures

When Stackarr runs in Docker, the same log entries are also emitted to container stdout, so `docker logs stackarr` stays useful.

The operation log intentionally avoids logging request bodies and redacts obvious secret-like keys such as passwords, tokens, secrets, cookies, and API keys. If you need more detail while testing, raise `STACKARR_LOG_LEVEL` to `debug`.

## Run The Interactive Demo

Use the demo when you want to review the full dashboard without touching a real Docker host:

```bash
cd stackarr
npm install
npm run demo
```

Then open `http://localhost:4687`.

In demo mode:

- all Docker operations are simulated
- import scan data is seeded automatically
- per-service actions mutate the demo state live
- `Open` buttons land on Stackarr-served stub app pages
- `Reset Demo` restores the seeded scenario

There is also a short guided walkthrough in [docs/demo-walkthrough.md](docs/demo-walkthrough.md).

## Product Foundation

The build decisions for scope, support tiers, onboarding, and Docker-first host support are documented in [docs/foundation.md](docs/foundation.md).

The detailed interaction and platform specs live in:

- [docs/product-spec.md](docs/product-spec.md)
- [docs/host-support.md](docs/host-support.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/roadmap.md](docs/roadmap.md)

## QNAP Notes

When Stackarr is running through `deploy/compose.example.yml`, the controller container already includes the Docker CLI. In the Stackarr wizard, the correct value is usually:

```text
Docker Binary: docker
```

For manual shell work directly on the QNAP, `docker` may still be missing from the NAS shell `PATH`. In that shell, use:

```text
/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
```

Recommended defaults for the same style of setup we validated on August 5, 2026:

```text
Compose Stack Root: /share/Container/docker
Config Root: /share/Container
Media Root: /share/Media
Downloads Root: /share/Media/Downloads
Plex Logs Path: /share/Container/plex/Logs
```

## Compose Template Defaults

Current port/image defaults in the MVP are aligned with mainstream current Docker docs and the live stack we audited:

- `Radarr`: `7878`
- `Sonarr`: `8989`
- `Lidarr`: `8686`
- `Prowlarr`: `9696`
- `Bazarr`: `6767`
- `Trailarr`: `7889`
- `Ombi`: `3579`
- `Tautulli`: `8181`
- `SABnzbd`: `8080`

## Why This Exists

Existing tools split the job:

- dashboards are good at links and status
- Docker control planes are good at generic stack operations
- app stores are good at one-click installs

Stackarr is trying to be opinionated for one user type:

- the Arr user who wants one install, one wizard, one dashboard, and one upgrade flow

## Suggested Next Milestones

1. One-click per-service cutover with inspect backup, confirmation, validation, and rollback hooks
2. Better update/version reporting for imported and externally managed services
3. Service-to-service onboarding helpers for Prowlarr, SABnzbd, and the Arr apps
4. Safer image rollback with explicit release snapshots
