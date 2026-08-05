# Testing Cutover Against Real Docker

Demo mode simulates every Docker call, and the automated tests use a stub
`docker` binary. Both prove sequencing and argument construction. Neither proves
that a real daemon behaves the way Stackarr expects.

This document covers the two steps between "passes in demo" and "migrated the
live NAS".

## Step 1: Rehearse on a throwaway container

Run this on any machine with Docker — a laptop is fine. It exercises the real
`docker stop`, `docker rename`, and `docker compose up` paths with no blast
radius, so a bug costs nothing.

Stackarr recognizes a container by **name first**, then by image repository.
That means a container named `ombi` is adopted as Ombi regardless of what image
it runs, so a small image is enough to rehearse with. Adoption requires
`/config` and `/Media` mounts.

```bash
mkdir -p /tmp/stackarr-rehearsal/{stacks,config/ombi/config,media,downloads,data}
```

```bash
docker run -d --name ombi -p 3579:80 -v /tmp/stackarr-rehearsal/config/ombi/config:/config -v /tmp/stackarr-rehearsal/media:/Media httpd:alpine
```

`httpd:alpine` answers HTTP on port 80, published here on Ombi's expected 3579.
Ombi accepts a 200 as healthy, so the verify step should resolve to `verified`
rather than `unverified` — which exercises the success path end to end.

Start Stackarr against a scratch data directory so this never touches real
state:

```bash
STACKARR_DATA_DIR=/tmp/stackarr-rehearsal/data STACKARR_LOG_LEVEL=debug npm start
```

In Settings, point every path at the rehearsal tree:

```text
Docker Binary:      docker
Compose Stack Root: /tmp/stackarr-rehearsal/stacks
Config Root:        /tmp/stackarr-rehearsal/config
Media Root:         /tmp/stackarr-rehearsal/media
Downloads Root:     /tmp/stackarr-rehearsal/downloads
Host URL:           http://localhost
```

Then: `Adoption` → `Scan Docker` → preview `ombi` → `Generate Managed Draft` →
`Cut Over To Compose`.

What should happen:

- every step goes green, `Roll back to the original container` shows `Not needed`
- `docker ps -a` shows a new Compose-managed `ombi` and a stopped `ombi-stackarr-rollback`
- `/tmp/stackarr-rehearsal/stacks/.stackarr-backups/ombi/<timestamp>/` holds
  `compose.yml`, `.env`, `inspect.json`, and `rollback.json`
- the Stack row shows `Managed` with a revert button

Then click revert and confirm the original container comes back under its
original name.

Worth rehearsing deliberately, since these are the paths that matter when
something goes wrong:

- **failed deploy**: occupy the port first (`docker run -d -p 3579:80 --name blocker httpd:alpine`
  after generating the draft but before cutting over) and confirm Stackarr
  restores the original container automatically
- **unverified**: publish the container on a port nothing answers on, and
  confirm the outcome reports `unverified` rather than success, and that the
  rollback container is kept

Clean up:

```bash
docker rm -f ombi ombi-stackarr-rollback blocker 2>/dev/null; rm -rf /tmp/stackarr-rehearsal
```

## Step 2: The live QNAP run

Only after Step 1 passes. Migrate one service, and make it `ombi` — it is the
simplest remaining bind-mounted app with the lowest blast radius.

Deploy this branch to the NAS and rebuild the controller:

```bash
cd deploy && docker compose -f compose.example.yml up -d --build
```

Set `STACKARR_LOG_LEVEL=debug` in `deploy/.env` before the first cutover. That
logs every Docker command and its full output, which is what you want the first
time this runs against real containers.

Before clicking anything, confirm:

- `docker ps` shows `ombi` running
- the dashboard shows Ombi as `Draft`, not `Detected` — if it shows `Detected`,
  generate the managed draft first
- no leftover rollback container: `docker ps -a --filter name=stackarr-rollback`
  should be empty
- `IMPORT-REVIEW.md` in the Ombi stack folder describes the container you expect

Watch it run:

```bash
docker logs -f stackarr
```

Afterwards, verify by hand rather than trusting the dashboard alone:

- Ombi's web UI loads and your existing requests and users are still there
- `/config` inside the new container holds the same database
- `docker inspect ombi` shows the mounts and restart policy you expect

Leave `ombi-stackarr-rollback` in place until you have used the app for a while.
Stackarr never deletes it; removing it is a deliberate manual step.

## Manual escape hatch

If the in-app revert fails, or the controller dies mid-cutover, this restores
the original container by hand:

```bash
docker compose -f /share/Container/docker/ombi/compose.yml down
```

```bash
docker rename ombi-stackarr-rollback ombi && docker start ombi
```

The pre-cutover state is preserved under
`<stackRoot>/.stackarr-backups/<service>/<timestamp>/`. `rollback.json` there
records the exact image id and repo digest the container was running, which is
what you need if the image tag has since moved.

## If the controller restarts mid-cutover

Jobs are persisted to `data/jobs.json`, so they survive a controller restart.
A job that was still running when the process died cannot be resumed — the
Docker work it was driving is gone with the process — so on startup it is
marked failed with `interrupted: true` and a message pointing at the rollback
container. Its step list shows exactly how far it got.

That step list is the thing to read. A job interrupted after `deploy` but
before `verify` means the Compose container is up but was never checked; a job
interrupted after `rename` but before `deploy` means nothing is serving.

Recovery has been tested from an interrupted state: the in-app revert works,
because it falls back to the conventional rollback name when the interrupted
job never recorded one. If it does not, use the manual escape hatch above.

## Known risks

- **Preflight is strict about drift.** If the live container changed since the
  draft was reviewed, cutover refuses with a 409. That is deliberate — the fix
  is to regenerate the draft and review it again, not to bypass the check.
- **Host networking** (`radarr`, `sonarr`) publishes no ports, so health
  verification falls back to the HTTP probe against the host URL. Confirm that
  URL is reachable before cutting those over, or expect `unverified`.
- **`sabnzbd` uses a custom QNAP network with a fixed LAN IP.** That network
  must already exist; Compose will otherwise try to create it. This is the
  highest-risk migration in the current group and should be last.
- **`tautulli` needs the read-only Plex logs mount.** Adoption flags a missing
  `/plex_logs` mount as a warning, not an error.

## What has and has not been verified

Run against a real Docker daemon (Docker 29.4.1, Compose v5.1.3) using the
Step 1 rehearsal above:

- cutover to `verified`, with Compose taking ownership and the original
  container preserved as `ombi-stackarr-rollback`
- `rollback.json` capturing the real pre-cutover image id and repo digest
- revert restoring the original container under its original name
- automatic revert after a genuinely failed `compose up`
- `unverified` when the container runs but the app URL does not answer, without
  tearing down a working container
- a `kill -9` mid-verify, then restart: the job is reported as interrupted with
  an accurate step list, and the in-app revert recovers from that state

Not yet verified:

- **the live QNAP stack.** Container Station's Docker and Compose versions,
  host networking, and the custom SABnzbd network are all still unexercised.
- upgrade and rollback of an already cut-over service over time.
