# Roadmap

What is built, what is next, and what is deliberately not being built.

This replaced a nine-phase plan that had gone stale — it still described
cutover and rollback as missing months after they shipped, which is the exact
failure this project keeps trying to avoid everywhere else.

## Where things stand

Everything in the original plan through Phase 6 is built and has run against a
real stack:

| Capability | Where the evidence is |
| --- | --- |
| Host detection, profiles, first-run setup | [testing.md](testing.md#lifecycle) |
| Compose generation per service, `.env` beside it | Live on QNAP and macOS |
| Install, upgrade, rollback, removal, reinstall | [testing.md](testing.md#lifecycle) |
| Adoption of existing containers, cutover and revert | Five apps on the live NAS |
| Config snapshots, so a rollback restores the database | Not just the image tag |
| Wiring across the whole stack | [testing.md](testing.md#wiring) |
| Controller password and a closed API | [testing.md](testing.md#credentials-and-safety) |
| Published multi-arch image | `ghcr.io/tx-joshg/keelarr` |

Twelve services in the catalog: Prowlarr, Radarr, Sonarr, Lidarr, Bazarr,
SABnzbd, qBittorrent, FlareSolverr, Jellyfin, Trailarr, Ombi, Tautulli.

## What is actually next

Not features. **Evidence.**

Keelarr has been proven on two hosts: a QNAP with a real library, and a Mac with
nothing on it. That is not "runs anywhere", and every feature added before that
gap closes is a feature nobody has confirmed works outside those two machines.

### 1. Other hosts

Linux with native Docker is the most likely platform of all and has never been
tried. Nor has any arm64 *host*, Synology, Unraid, TrueNAS, WSL2, or rootless
Docker. These are listed as [help wanted](testing.md#help-wanted) because they
need hardware nobody on the project has.

### 2. Live proof for what is only unit-tested

Two things ship with tests but no live run: qBittorrent registered into a real
Arr, and Jellyfin inside a real stack. Both are in the catalog, so the honest
position is that they install and are covered by fixtures — not that they are
proven.

### 3. Scale

Everything here was proven against stacks of nine services or fewer. The wiring
check's readiness budget and the update-check timings are guesses above that.

## Known limits

Stated so nobody spends time rediscovering them:

- **Windows is unsupported outside WSL2**, by design. Keelarr mounts host paths at
  the same absolute path inside the container, and `C:\` has no equivalent.
- **A restored app can hold a stale address.** If a container moved while the app
  was gone, its own database still points at the old one. The wiring check
  reports this as drift for apps with an API; for Trailarr and Ombi it can only
  warn, because correcting it would mean writing into their schema.
- **Trailarr, Ombi and Tautulli are not wired.** They are deployed, health-checked
  and monitored. Their settings live in SQLite with no documented write API, and
  writing into another app's schema is out of scope — it breaks on their next
  migration and Keelarr would own the corruption.
- **The Docker socket path is hardcoded** to `/var/run/docker.sock`.

## Not being built

- A generic homelab dashboard. Keelarr is opinionated about one stack.
- Anything that edits another app's database schema.
- Anything that reads or writes indexers. They carry credentials you paid for.
- Storing app API keys. They are read when needed and never persisted.
- A hosted service.

## Ideas without commitments

Worth doing eventually, in no particular order, and none of them before the
evidence gap closes:

- An adapter for Synology and Unraid path conventions, once someone confirms what
  generic detection actually suggests there.
- Correcting Tautulli's Plex link, which is plain ini text rather than a database.
- Reporting drift on a schedule rather than only when asked.
- A read-only mode for people who want the dashboard without the write paths.
