# Stackarr MVP

Stackarr is an Arr-focused control plane MVP for Docker Compose environments. It is intentionally narrow: install and manage the media automation stack from one controller rather than trying to be a generic homelab dashboard.

## Scope

This MVP is built around:

- Prowlarr
- Radarr
- Sonarr
- Lidarr
- Readarr
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
- `.env` generation beside each stack
- Read-only Docker inventory scan for existing container adoption
- Per-container adoption preview
- Safe managed-draft generation for recognized existing containers
- Per-service deploy
- Per-service update check
- Per-service upgrade
- Upgrade-all action
- Deep links into each app
- Interactive demo mode with simulated actions and stub app destinations
- Reachability checks against each app URL
- Compose runtime checks via `docker compose ps`
- Pre-upgrade backups of compose files and container inspect output

## What Is Still Deliberately Missing

- Authentication and multi-user access control
- Full import adoption and cutover flow
- Full rollback to previous images
- App-to-app API provisioning
- Reverse proxy and certificate automation
- One-click indexer/download-client/provider setup inside each app
- Generic marketplace support for unrelated self-hosted software

## Project Shape

```text
stackarr/
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

There is also a short guided walkthrough in [stackarr-demo-walkthrough.md](/Users/joshgoble/Documents/Codex/2026-08-03/i-have-a-qnap-nas-running/outputs/stackarr-demo-walkthrough.md).

## Product Foundation

The build decisions for scope, support tiers, onboarding, and Docker-first host support are documented in [docs/foundation.md](/Users/joshgoble/Documents/Codex/2026-08-03/i-have-a-qnap-nas-running/stackarr/docs/foundation.md).

The detailed interaction and platform specs live in:

- [docs/product-spec.md](/Users/joshgoble/Documents/Codex/2026-08-03/i-have-a-qnap-nas-running/stackarr/docs/product-spec.md)
- [docs/host-support.md](/Users/joshgoble/Documents/Codex/2026-08-03/i-have-a-qnap-nas-running/stackarr/docs/host-support.md)
- [docs/architecture.md](/Users/joshgoble/Documents/Codex/2026-08-03/i-have-a-qnap-nas-running/stackarr/docs/architecture.md)
- [docs/roadmap.md](/Users/joshgoble/Documents/Codex/2026-08-03/i-have-a-qnap-nas-running/stackarr/docs/roadmap.md)

## QNAP Notes

On QNAP Container Station, the Docker binary is often not on the non-interactive shell path. In Stackarr's wizard, set:

```text
Docker Binary: /share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
```

Recommended defaults for the same style of setup we migrated on August 4, 2026:

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
- `Readarr`: `8787`
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

1. Service-to-service onboarding helpers for Prowlarr, SABnzbd, and the Arr apps
2. Download client templates beyond SABnzbd
3. Reverse proxy integration helpers
4. Safer image rollback with explicit release snapshots
