# What Has Been Tested

This file exists because "tested" is not one thing. A unit test proves the code
does what it was written to do. Only a live run proves it does what it *claims*.
Nearly every defect worth fixing in this project was found by the second kind,
while the first kind stayed green — so the two are recorded separately, and
neither is described as the other.

Nothing in the README claims more than a row here supports.

## How to read this

| Level | What it means |
| --- | --- |
| **Automated** | Covered by `npm test`. Runs anywhere, proves behaviour against fixtures. |
| **Live** | Run against real containers on a real host. Says which host. |
| **Community** | Nobody involved so far owns this hardware. Listed in [Help wanted](#help-wanted). |

Hosts used so far:

- **QNAP** — Container Station on x86_64, a stack that predates Keelarr and holds
  real media. Most live evidence comes from here.
- **macOS** — Docker Desktop on Apple Silicon, used for from-nothing installs
  where breaking things costs nothing.

## Lifecycle

| Scenario | Level | Evidence |
| --- | --- | --- |
| Fresh install from an empty host | Live · macOS | Clone → `docker compose up -d` with no editing → controller starts, creates its own network, first-run password, host detection, service installed |
| The quick start exactly as documented | Live · macOS | `curl` the compose file and `docker compose up -d`, no clone and no editing, against the **published** image pulled anonymously: healthy in 1 second, first-run password set, detection returned generic-docker at high confidence with `$HOME/keelarr` paths, validation clean with no errors and no warnings |
| The published image is pullable by a stranger | Live | Anonymous token from `ghcr.io`, manifest fetched with no credentials, `linux/amd64` and `linux/arm64` both present |
| Install a single service | Live · QNAP | FlareSolverr and qBittorrent installed from the catalog, generated `compose.yml` and `.env` on disk |
| Install every service from scratch | Live · macOS | Seven services from an empty host. See [Full lifecycle](#full-lifecycle-macos) |
| Upgrade one service | Live · QNAP + macOS | Sonarr, Ombi, SABnzbd, Bazarr, Trailarr — image changed, config intact. Prowlarr again on macOS |
| Upgrade everything | Live · QNAP | Planned from stored update state; only services with a known update are touched |
| Downgrade / rollback | Live · QNAP | Image pinned to the previous digest, config snapshot restored, pin cleared afterwards |
| Rollback with nothing to roll back to | Live · macOS | The "newer" image had the same digest; reported as unavailable rather than pinning to itself |
| Change a service's port | Live · macOS | Port override saved, container recreated on the new port, wiring re-resolved to it |
| Remove, keeping configuration | Live · QNAP + macOS | Prowlarr and Radarr on the NAS; on macOS, Prowlarr removed and reinstalled with a byte-identical API key and database |
| Remove everything | Live · QNAP | Bazarr and Lidarr removed with container, config, image, stack files and backups; nothing left behind |
| Redeploy after removal | Live · QNAP | Reinstall restores the archived compose rather than generating a catalog default |
| Adopt an existing container | Live · QNAP | Read-only scan → managed draft → cutover → revert, on Trailarr, Radarr, Sonarr, SABnzbd and Ombi |
| Identity applied across a whole stack | Live · QNAP | Eight services moved to one `PUID`/`PGID` from settings — six of them adopted stacks that had kept each image's own default. Two had been running as **root**. Config directories re-owned alongside; `/share/Media` untouched |
| Identity written into an adopted stack | Automated | Only `PUID`/`PGID` change: image, ports, mounts, `.env` values and entrypoint survive verbatim. A service that runs as its own user is not given a `PUID` it cannot honour |

## Wiring

| Scenario | Level | Evidence |
| --- | --- | --- |
| Download client into Radarr/Sonarr/Lidarr | Live · QNAP + macOS | SABnzbd registered, category created, tested by the app itself before writing. Repeated from nothing on macOS |
| A fresh SABnzbd refusing its own hostname | Live · macOS | 403 by name, 200 by IP; the hostname is added through SABnzbd's own API and existing entries are kept. See [Full lifecycle](#full-lifecycle-macos) |
| Torrent client registration | Automated | Generalised payload covers qBittorrent; not yet written into a live Arr |
| Apps registered with Prowlarr | Live · QNAP | Radarr and Sonarr, both directions of the address |
| Bazarr pointed at Radarr and Sonarr | Live · QNAP | Written as a settings document and read back, because Bazarr answers 204 whether or not it applied the change |
| FlareSolverr registered in Prowlarr | Live · QNAP | Removed, reinstalled, and registered automatically with no operator action |
| Library folders created | Live · QNAP | Created on the host path behind the container path, inheriting the parent's ownership |
| Address resolution across network modes | Live · QNAP | host, macvlan (`qnet`), bridge and shared-network all resolved; unroutable pairs reported as blocked rather than given an address that times out |
| Existing configuration left alone | Live · QNAP | A download client pointing elsewhere is reported as drift and never overwritten |
| Leftovers from a removed app | Live · QNAP | Prowlarr's proxy for a deleted FlareSolverr, and its sync to a deleted Lidarr, both detected |

## Credentials and safety

| Scenario | Level | Evidence |
| --- | --- | --- |
| API keys never returned by the API | Automated | A test asserts no 32-hex key appears in any response |
| API keys never written to the log | Automated · Live | Config reads are marked sensitive; verified on the NAS that the log holds byte counts rather than contents |
| Controller password | Live · QNAP | First-run setup, login, wrong password, sign-out, lapsed session, survives a restart |
| API closed without a session | Live · QNAP | 401 on `/api/state` from the host and from another machine |
| Health probe stays open | Live · QNAP | `/api/health` answers unauthenticated, which is what the container healthcheck uses |
| Indexers never touched | By design | Keelarr counts them and never reads or writes them; they carry paid credentials |

## Operations

| Scenario | Level | Evidence |
| --- | --- | --- |
| A failed upgrade is put back when asked, and reported when not | Automated | With auto-revert on, an upgrade that does not come back is pinned to the previous image's digest and the update state says `rolled-back`; off, it is reported and left running exactly as before. The four combinations are asserted on call order, not just outcome |
| A revert that does not come back either is reported as down | Automated | The previous image is pinned and the state says `rolled-back` — that is what keeps the nightly run away — but the result is a failure that says "did not come back either", not a recovery |
| A compose-up that never started the new image is left retryable | Automated | Revert off, or revert on but refused: neither writes "current" for a container that does not exist, so Upgrade All tries it again rather than skipping it forever |
| A revert whose deploy fails does not leave the pin behind | Automated | The compose file goes back to the tag, so the next ordinary deploy does not target a revert that never happened |
| A revert refuses rather than guesses | Automated | No revert when the previous image is gone from the host, or when the newest backup is not the image that was actually running — `findRollbackPoint` skips the running image, so a pull that changed nothing would otherwise hand back an older one |
| An upgrade is never recorded as current on its way to being reverted | Automated | Every update-state write is captured; the health check now runs before any is made |
| The install window opens at the configured time, in the configured zone | Automated | 03:00 in America/Chicago is 08:00Z and not 03:00Z; a window fires once per local day; one that opens before midnight can close after it; a window missed entirely waits for tomorrow rather than running at boot |
| A scheduled install touches only the apps that opted in | Automated | Only opted-in images are checked or pulled; a job step per opted-in app records "already current" rather than hiding it; a run with nothing opted in claims the window and creates no job |
| The scheduled run holds the lease for its whole life | Automated | A removal or cutover started underneath an unattended upgrade is refused, naming the scheduled update; released when the run ends. Asserted from inside the upgrade. Cutover revert, restart and Save And Deploy now check the lease too — the first never had |
| The lease outlives a run longer than its term | Automated | A heartbeat renews the claim for as long as the run is alive — a single pull has no deadline and can outlive the term by itself — and it stops with the run; a holder that has gone quiet still expires, and nobody else can renew it |
| A manual action mid-work keeps the scheduler out | Automated | Every manual mutation is counted as in flight from before its first await until it settles, the tick stands aside while one is, and the lease cannot be taken meanwhile. Checking the lease alone left a gap the tick could take between the check and the work |
| Undoing a refused claim leaves a Run Now alone | Automated | Only this tick's window key is put back; a manual run that wrote its own job id in the gap keeps it. Every change to the schedule's state is applied one at a time as a function of what is on disk, so two writers cannot put each other's fields back, and a manual run never writes the window key at all |
| One tick at a time | Automated | A tick slowed by state I/O is not joined by the next; two ticks that both read an unclaimed window would start one run and then undo its claim. A claim already held by this window's scheduled run is never undone |
| A failed bookkeeping write does not stop the run | Automated | Recording the job id is best effort once the window is claimed; a claimed window with no run is the one outcome worse than a run with no record |
| A stalled pull is reported as stalled | Automated | The command runner's diagnosis comes before the last progress line in the failed step's error |
| Run Now stands aside for a running job, like the tick | Automated | A cutover answers its request as soon as its job is registered and keeps working; Run Now is refused while any job is running rather than upgrading underneath it |
| Save And Generate is in flight like a deploy | By design | It rewrites every selected stack's compose file whether or not it deploys, which under a running upgrade is the file between its pull and its up; it goes through the same lease tracking as every other manual action |
| A lease taken between the stand-aside check and the start does not burn the window | Automated | The claim is undone and the next tick inside the window runs, rather than every tick that night answering "already ran" for a run that never started |
| A reverted app that stays down is a failure, not a recovery | Automated | Counted under "failed" in the scheduled summary, with the step error saying it did not come back either |
| A pin that cannot be cleared is reported as still there | Automated | When the revert's deploy fails and the compose file cannot be put back on the tag either, the result says which digest it is still pinned to instead of claiming it was unpinned |
| A failed image check is part of the outcome | Automated | A pull that fails for one app is a failed step naming the registry error, the check step counts it, the summary says "could not be checked", and the activity entry is a warning rather than a clean run |
| A run started by hand is recorded as itself | Automated | Run Now writes its own job id and trigger without claiming tonight's window, so its summary is never filed under the previous scheduled run |
| An open window is reported as the next run | Automated | At 03:10 with the window unclaimed, the dashboard says 03:00 today, not tomorrow; once claimed, tomorrow |
| The window stands aside and retries rather than piling on | Automated | A running job or a controller update in progress leaves the window unclaimed for the next tick; the window is claimed before any work starts so a long job cannot be started twice |
| A reverted app is left alone by the nightly run | Automated | The nightly check overwrites its status with "ready" — the tag has moved on — so the pinned compose file is the signal, and only a person pressing Upgrade clears it |
| An app that opted in but has no stack is skipped as such | Automated | A stack removed after opting in, or a hand-edited settings file, is skipped with "Not deployed by Keelarr" rather than reported as current, and its image is not pulled — even when a stale "ready" is still on record for it |
| Handing an app back to its original container drops the opt-in | Automated | A cutover revert clears `autoUpdate` with the mode, so no AUTO tag is left on a row Keelarr no longer owns |
| Uptime and last upgrade per app | Automated | The inventory keeps `State.StartedAt` and `RestartCount` it already had (Docker's never-started sentinel becomes null); the dashboard carries `startedAt` and `lastUpgradedAt`, the latter surviving the app being stopped |
| Auto-update toggled from the row menu | Live · macOS | On the demo controller: the item reads "Turn auto-update on/off", the toggle saves through its own endpoint, an `AUTO` tag appears on the version line, the summary counts the app, and the Settings intro names it. A catalog-only app has the item disabled with "Install it first."; a detected app, running outside Keelarr, with "Cut over first." — a scheduled install is an Upgrade nobody is watching, and Upgrade only works on a stack Keelarr owns |
| Schedule and auto-revert saved from Settings | Live · macOS | The Updates fieldset sits after Backups. Turning the schedule on enables the hour and minute selects; Save then round-trips `autoUpdateEnabled`, `autoUpdateTime` (04:30) and `autoRevert` through `/api/state`, and the per-app `autoUpdate` override survives the settings save because the form never sends `serviceOverrides` |
| The dashboard says whether a scheduled install will actually happen | Live · macOS | With the schedule off the tag is grey and the summary says "schedule off"; with it on the tag is blue and the summary says "installs at 04:30". A container named exactly what Keelarr would have named it is not printed under the app's name; anything else — `rad-arr`, `RADARR`, `sonarr-4k-vpn` — still is, on the row rather than in a tooltip, since there is no hover on a phone and a title attribute is not reliably read out. The uptime is bare on screen and carries the word "Up" as text drawn off-screen, since `aria-label` is prohibited on a plain span; the timer moves the number and leaves the word alone. Every running row shows its uptime as a bare `<duration>` and an upgraded app shows `upgraded <relative>`, with the absolute time in the tooltip. Both move along every thirty seconds without a re-render, so an open row menu is not closed by the clock |
| Update checks on a schedule | Automated | Daily, at startup when overdue, after install, on request — and nowhere else |
| Slow image pulls | Live · QNAP | A 175-second pull completes; judged on progress rather than a fixed deadline |
| Stalled pulls | Automated | A command that goes silent is reported as stalled, distinctly from one that is merely slow |
| Log growth | Live · QNAP | Rotates at 5MB keeping two files; a 38MB log retired on first write |
| Controller restart | Live · QNAP | Port opens in 17 seconds, healthy in 29, with initialisation continuing behind it |
| Deploy that changes nothing | Live · QNAP | Reported as already up to date; confirmed by uptime that unchanged containers are not restarted |
| Wiring that needs to change nothing | Live · macOS | Reported as a finished job, not a failure — it runs automatically after every install, and a red failure over a successful install is a lie |
| Wiring that cannot write anything | Live · macOS | Says what stopped it — unreachable, still starting, or left alone — instead of claiming the stack is fully configured |
| A port already held by something else | Live · macOS | Names the port. Found because an unrelated project on the machine held 8080 |
| Keelarr replaces its own container | Live · macOS | 0.1.3 to 0.1.4 on a disposable instance: container replaced, version reported by the new controller, `deploy/.env` version moved with every other line byte-identical, data directory intact, receipt `succeeded`, handed-off job finalised |
| A broken release is rolled back automatically | Live · macOS | A deliberately broken image published as the target: it crash-looped, the updater waited out its acknowledgement window, restored the previous image and came back running. `deploy/.env` byte-identical to the pre-update backup, with no internal tag left pinned |
| The updater does not inherit the image's own environment | Automated · Live · macOS | Compose gives the shell precedence over `--env-file`, and the updater runs the Keelarr image, which exports `KEELARR_DATA_DIR=/app/data`. Caught live: the recreate bound the container path as a host path |
| The controller update hands off rather than reporting success | Automated | The job is recorded as handed-off, not succeeded, and survives a hydrate — a handler that returned would have persisted a success before the container was stopped |
| The updater is given the right project and paths | Automated | The deploy directory is mounted at its own host path on both sides, every compose file is replayed in order with the project name and the one service, and the updater runs the current image rather than the one being installed |
| An update that cannot start changes nothing | Automated | A new image that does not run here, and an updater that cannot be launched, both leave `deploy/.env` byte-identical and release the lease |
| An update outcome is derived from the running container | Automated | Success, rollback and still-deciding are read from the image the container is actually on, not from the updater's word; a settled outcome is never re-derived on a later start |
| Controller update discovery | Automated · Live · macOS | The newest release is compared numerically, so 0.1.10 is newer than 0.1.9; a failed check keeps the previous answer and says why rather than reading as up to date; and the footer shows the version stale with the release named |
| A controller that cannot update itself says why | Automated | One refusal per cause — no socket, no compose project, no deploy or data mount, a locally built image, another job running — each carrying the reason the UI prints |
| A controller that cannot be reached on first load | Live · macOS | Assets served with the API down — the shape a reverse proxy produces when the app is gone — reports what answered instead of sitting on `Loading...` forever, and `Try again` recovers in place without a reload |
| `PUID` checked against the library, not just the media root | Automated · Live · QNAP | The share is `0:0` mode 777 while the title folders inside it are `911:911` mode 755 — a root-only check passes and every real write still fails, so validation samples the folders apps actually write into |

## Full lifecycle · macOS

One run, from an empty host to a fully wired stack, on Docker Desktop for Apple
Silicon. Seven services: Prowlarr, FlareSolverr, SABnzbd, qBittorrent, Radarr,
Sonarr, Bazarr. Everything below was done through Keelarr, not with `docker run`
— installing by hand would have skipped the very path under test.

| Step | Result |
| --- | --- |
| Clone and `docker compose up -d`, no editing | Controller answered in 2 seconds |
| First-run password, then sign in | Set and accepted |
| Host detection | `generic-docker`, every root reported `mounted-root` |
| Save the host profile | No diagnostics |
| Install seven services | All seven deployed and running |
| Upgrade Prowlarr | Image changed; its API key and database survived |
| Roll back Prowlarr | Correctly reported unavailable — the new image had the same digest, so there was nothing to roll back to |
| Remove Prowlarr, keeping configuration | Config directory kept, container and stack files removed |
| Reinstall Prowlarr | Same API key, same `prowlarr.db` — the config came back rather than being regenerated |
| Change SABnzbd's port and redeploy | Recreated on the new port |
| Wire the whole stack | Every link reported `correct` |

Four defects were found by this run and fixed in it. Each had passed the unit
suite:

- **A port already in use reported no port.** Something unrelated on the machine
  held 8080, and the deploy failure said only that deployment failed. It now
  names the port and what to do about it.
- **A running container was reported reachable without being probed.** Now
  tri-state: reached, refused, or not known.
- **Installing a service that was not already selected failed** with "Unknown or
  disabled service" — the install action could not install.
- **SABnzbd refused every connection on a fresh install.** See below.

### SABnzbd's hostname whitelist

The one that would have broken every from-scratch install:

A fresh SABnzbd whitelists only the hostname it sees itself as, which inside a
container is the container *ID*. It answers `403` to every other name —
including its own container **name**, which is exactly what Keelarr and every
Arr app use on a shared network. Verified directly from inside the controller:

```
http://sabnzbd:8080/api?mode=version   → 403 Forbidden
http://172.25.0.9:8080/api?mode=version → {"version":"5.1.0"}
```

Nothing in the QNAP evidence caught this, because that SABnzbd predates Keelarr
and already had its hostname accepted. Keelarr now appends the hostname through
SABnzbd's own API, addressed by IP — the hostname cannot carry its own fix — and
keeps every entry already present, because SABnzbd's API replaces the list
rather than appending to it.

After the fix, from the same fresh state, one wiring run reported:

> Told SABnzbd to accept `sabnzbd` as a hostname. Added the "movies" category so
> Radarr can separate its downloads. Added the "tv" category so Sonarr can.
> Configured 2 connections.

### A test that wrote to a real file

Not a product defect, but it cost more time than any of them and would have hit
any contributor: `test/host-profile-service.test.js` stubbed the settings layer
but left the controller-env layer real. Running `npm test` inspected the
developer's actual Docker, found their running controller, and overwrote that
controller's `deploy/.env` with the QNAP paths from a test fixture — silently,
because the write happened in the test process and never reached the app's log.
The controller then failed to start with a Docker mounts error naming paths that
appear nowhere in its settings.

The test now stubs the writer and asserts nothing is written. The rule it broke
is worth stating plainly: **a test must stub every injected implementation that
touches Docker or the filesystem.** Stubbing one layer is not enough if a layer
underneath still reaches the real machine.

## Platforms

| Platform | Level | Notes |
| --- | --- | --- |
| QNAP Container Station (x86_64) | Live | The primary test host |
| macOS + Docker Desktop (arm64) | Live | A full lifecycle from an empty host, seven services, ending fully wired. Still not a realistic long-term host — no media on it |
| Linux x86_64 | **Untested** | The most likely platform of all. Native Docker, POSIX paths |
| Linux arm64 / Raspberry Pi | **Untested** | The arm64 *image* is verified to boot; no arm64 *host* has run it |
| Synology DSM | **Untested** | No adapter; would fall back to generic detection |
| Unraid | **Untested** | `/mnt/user` paths |
| TrueNAS SCALE | **Untested** | Docker availability varies by version |
| Windows | **Unsupported** | Keelarr mounts host paths at the same absolute path inside the container, which `C:\` cannot satisfy. Run it inside WSL2 with POSIX paths |
| Rootless Docker / Podman | **Untested** | The socket path is hardcoded to `/var/run/docker.sock` |

## Help wanted

These need hardware, an operating system, or an app nobody on the project has.
Each is written to be closeable without a conversation first: run the steps,
paste the output, say what your host is. A report that something *worked* is
worth exactly as much as a bug — most rows in this file cover two hosts, and
two hosts is not "any Linux box".

If you are reporting, please redact: API keys, indexer names, Usenet server
hostnames, Plex tokens, and anything under `/api/…?apikey=`.

The first two are open as GitHub issues — they are the ones that matter, because
"runs on Linux" is the claim this project most wants to be able to make and
currently cannot. The rest are listed here and will be opened as anyone shows
interest, rather than filling the tracker with nine unattended issues.

| # | Scenario | What would close it |
| --- | --- | --- |
| 1 | **Linux x86_64, native Docker** — [issue #1](https://github.com/tx-joshg/keelarr/issues/1) | The most likely host of all, and completely untested. Run the [full lifecycle](#full-lifecycle-macos) steps and say which ones did not behave as described |
| 2 | **Raspberry Pi / arm64 host** — [issue #2](https://github.com/tx-joshg/keelarr/issues/2) | The arm64 image is verified to boot; no arm64 *host* has run the controller. Install two services and paste the output of the stack check |
| 3 | **Synology DSM** | There is no adapter, so detection falls back to generic. Say what it detected, and whether the suggested paths were right for DSM |
| 4 | **Unraid** | Paths live under `/mnt/user`. Say whether host detection suggested usable roots |
| 5 | **TrueNAS SCALE** | Docker availability varies by version. Say which version, and whether the controller could reach the socket |
| 6 | **WSL2 on Windows** | Keelarr mounts host paths at the same absolute path inside the container, which `C:\` cannot satisfy — inside WSL2 with POSIX paths it should work. Nobody has confirmed it does |
| 7 | **Rootless Docker or Podman** | The socket path is hardcoded to `/var/run/docker.sock`. Say where yours is and whether pointing at it was enough |
| 8 | **qBittorrent registered into a live Arr** | The payload is covered by tests but has never been written into a real Radarr or Sonarr. Wire it and say whether the connection test passed |
| 9 | **Jellyfin in a real stack** | It is in the catalog and installs, but no live stack has been built around it |
| 10 | **A stack larger than nine services** | Everything here was proven against small stacks. Timings and the wiring check's readiness budget may not hold at twenty |
| 11 | **Adopting containers Keelarr did not create** | Proven on five apps on one NAS. Any adoption of a container with an unusual network mode, a named volume, or a non-standard config path is useful |

Two known limits, so nobody spends time rediscovering them:

- **Windows is unsupported outside WSL2**, by design — the same-absolute-path
  mount model has no `C:\` equivalent.
- **A restored app can hold a stale address.** If a container moved while the app
  was gone, its own database still points at the old one. The wiring check
  reports this as drift for apps with an API; for Trailarr and Ombi it can only
  warn, because correcting it would mean writing into their schema.
