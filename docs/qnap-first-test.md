# Stackarr QNAP Live Status

This document records the state of the live QNAP deployment. It is the source
of truth for what is actually running, and supersedes earlier drafts that
described only the first Trailarr migration.

Last verified: August 5, 2026, against GobleNAS (QNAP, Docker 29.5.3,
Compose v5.1.4).

## Current State

All eight catalog services are managed by Stackarr.

| Service | Origin | Network | Notes |
| --- | --- | --- | --- |
| `radarr` | imported | host | |
| `sonarr` | imported | host | |
| `sabnzbd` | imported | `qnet-static-eth1` (static 198.51.100.10) | |
| `ombi` | imported | bridge | |
| `tautulli` | imported | bridge | read-only Plex logs mount |
| `trailarr` | imported | project default | |
| `prowlarr` | installed from catalog | `stackarr` | |
| `bazarr` | installed from catalog | `stackarr` | |

Controller: `/share/Container/stackarr`, data in
`/share/Container/stackarr/data`, generated stacks under
`/share/Container/docker/<service>/`.

## How The Imports Were Recovered

The six pre-existing services had been cut over to Compose on August 4, but
their generated compose files were later deleted while their containers kept
running. That left them Compose-labelled but orphaned: running, yet with no
file for Stackarr to manage them through.

Because each container still carried its original Compose labels, writing a
faithful draft back to the recorded path was enough to bring it under
management — no container was stopped and there was no downtime. The full
stop/rename/recreate cutover was not needed for any of them.

That is worth remembering: a service whose container already carries Compose
labels for the same project only needs its compose file restored.

## Verified On This Host

- adoption drafts that reproduce the live container, including host networking,
  a custom network with a static address, named volumes, and entrypoint and
  command overrides
- per-service versions read from image labels rather than the image tag
- update detection across the stack
- a real upgrade of Tautulli, then a rollback to the previous image digest,
  then an upgrade forward again that cleared the rollback pin
- one-click install of Prowlarr and Bazarr, both healthy and reachable
- inter-app connectivity (see below)

## Networking

Every Compose project gets its own network by default, which leaves services
unable to reach each other. Catalog-installed services therefore join a shared
`stackarr` network and resolve each other by container name. Stackarr creates
that network on demand.

Imported services keep whatever network they were already on, so their live
shape is preserved. In this stack that means:

- `prowlarr` and `bazarr` reach each other by name over the shared network
- `prowlarr` and `bazarr` reach `radarr` and `sonarr` at the host address,
  since those run with host networking
- `sabnzbd` is reachable at its own static LAN address
- the bridge-networked imports (`ombi`, `tautulli`, `trailarr`) are not
  reachable from other containers, which does not matter as nothing needs to
  call them

If those ever need to be reachable, re-adopting them onto the shared network
would be the fix.

## Safety Rules

- migrate one container at a time
- do not delete config directories
- do not delete named or unnamed volumes unless their purpose is confirmed
- use the running container as the source of truth
- leave rollback artifacts in place until the replacement is validated

## Known Gaps

- `tautulli` reports no version because its image labels itself `master`
- Synology support is unimplemented
