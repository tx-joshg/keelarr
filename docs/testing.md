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
| Update checks on a schedule | Automated | Daily, at startup when overdue, after install, on request — and nowhere else |
| Slow image pulls | Live · QNAP | A 175-second pull completes; judged on progress rather than a fixed deadline |
| Stalled pulls | Automated | A command that goes silent is reported as stalled, distinctly from one that is merely slow |
| Log growth | Live · QNAP | Rotates at 5MB keeping two files; a 38MB log retired on first write |
| Controller restart | Live · QNAP | Port opens in 17 seconds, healthy in 29, with initialisation continuing behind it |
| Deploy that changes nothing | Live · QNAP | Reported as already up to date; confirmed by uptime that unchanged containers are not restarted |
| Wiring that needs to change nothing | Live · macOS | Reported as a finished job, not a failure — it runs automatically after every install, and a red failure over a successful install is a lie |
| Wiring that cannot write anything | Live · macOS | Says what stopped it — unreachable, still starting, or left alone — instead of claiming the stack is fully configured |
| A port already held by something else | Live · macOS | Names the port. Found because an unrelated project on the machine held 8080 |

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

| # | Scenario | What would close it |
| --- | --- | --- |
| 1 | **Linux x86_64, native Docker** | The most likely host of all, and completely untested. Run the [full lifecycle](#full-lifecycle-macos) steps and say which ones did not behave as described |
| 2 | **Raspberry Pi / arm64 host** | The arm64 image is verified to boot; no arm64 *host* has run the controller. Install two services and paste the output of the stack check |
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
